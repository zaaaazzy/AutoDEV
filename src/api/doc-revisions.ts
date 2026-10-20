import type { Router, NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import { hasRole, type Principal } from './roles.js';

/**
 * Dokumente bearbeiten mit Redaktionsprüfung: Änderungen werden als Revision eingereicht (Inhalt vorher/nachher),
 * das Dokument ändert sich erst, wenn die Redaktion freigibt. Repository-Dokumente spiegeln Dateien und bleiben
 * schreibgeschützt.
 */
const COLUMNS = `r.id, r.doc_id AS "docId", r.title, r.content, r.base_title AS "baseTitle", r.base_content AS "baseContent",
  r.note, r.status, r.author_id AS "authorId", r.author_name AS "authorName", r.reviewer_name AS "reviewerName",
  r.review_note AS "reviewNote", r.reviewed_at AS "reviewedAt", r.created_at AS "createdAt"`;

export function registerDocRevisionRoutes(app: Router, pool: Pool): void {
  const me = (response: Response) => response.locals.principal as Principal;

  app.get('/projects/:slug/doc-revisions', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const revisions = (
        await pool.query(
          `SELECT ${COLUMNS} FROM doc_revisions r JOIN docs d ON d.id = r.doc_id
            WHERE d.project_slug = $1 ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 300`,
          [slug],
        )
      ).rows;
      response.json({ revisions });
    } catch (error) {
      next(error);
    }
  });

  app.post('/docs/:id/revisions', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Dokument nicht gefunden.' });
      const body = (request.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const content = typeof body.content === 'string' ? body.content : '';
      if (!title || title.length > 180 || content.length > 30_000) {
        response.status(400).json({ message: 'Titel (max. 180 Zeichen) und Inhalt (max. 30 000 Zeichen) prüfen.' });
        return;
      }
      const doc = (
        await pool.query<{ title: string; content: string; kind: string }>(
          'SELECT title, content, kind FROM docs WHERE id = $1',
          [request.params.id],
        )
      ).rows[0];
      if (!doc) return void response.status(404).json({ message: 'Dokument nicht gefunden.' });
      if (doc.kind === 'repo' || doc.kind === 'request') {
        response
          .status(400)
          .json({ message: 'Repository-Dokumente und Anfragen sind ein Protokoll und schreibgeschützt.' });
        return;
      }
      if (doc.title === title && doc.content === content) {
        response.status(400).json({ message: 'Es gibt keine Änderung zum Einreichen.' });
        return;
      }
      const principal = me(response);
      const result = await pool.query(
        `INSERT INTO doc_revisions (doc_id, title, content, base_title, base_content, note, author_id, author_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, doc_id AS "docId", status, created_at AS "createdAt"`,
        [
          request.params.id,
          title,
          content,
          doc.title,
          doc.content,
          typeof body.note === 'string' ? body.note.slice(0, 500) : '',
          principal.id,
          principal.displayName,
        ],
      );
      response.status(201).json({ revision: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  const review =
    (decision: 'approved' | 'rejected') => async (request: Request, response: Response, next: NextFunction) => {
      try {
        if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Änderung nicht gefunden.' });
        const principal = me(response);
        const revision = (
          await pool.query<{
            doc_id: string;
            title: string;
            content: string;
            status: string;
            author_id: string | null;
          }>('SELECT doc_id, title, content, status, author_id FROM doc_revisions WHERE id = $1', [request.params.id])
        ).rows[0];
        if (!revision) return void response.status(404).json({ message: 'Änderung nicht gefunden.' });
        if (revision.status !== 'pending') {
          return void response.status(409).json({ message: 'Diese Änderung wurde bereits geprüft.' });
        }
        // Vier-Augen-Prinzip: eigene Änderungen gibt nur frei, wer zusätzlich Administrator ist.
        if (
          decision === 'approved' &&
          revision.author_id &&
          revision.author_id === principal.id &&
          !principal.roles.includes('admin')
        ) {
          return void response
            .status(403)
            .json({ message: 'Eigene Änderungen muss jemand anderes aus der Redaktion freigeben.' });
        }
        const rawNote = (request.body as { note?: unknown } | undefined)?.note;
        const note = typeof rawNote === 'string' ? rawNote.slice(0, 500) : null;
        const values = [request.params.id, decision, principal.displayName, note];
        const mark = `UPDATE doc_revisions SET status = $2, reviewer_name = $3, review_note = $4, reviewed_at = NOW()
                       WHERE id = $1 AND status = 'pending'`;
        // Freigabe in einer Anweisung: Das Dokument ändert sich nur, wenn es noch dem Stand bei der Einreichung
        // entspricht (sonst würde eine ältere Revision neuere Änderungen überschreiben), und die Revision wird nur
        // dann freigegeben. Bei gleichzeitigen Freigaben gewinnt genau eine.
        const sql =
          decision === 'approved'
            ? `WITH doc AS (
                 UPDATE docs d SET title = r.title, content = r.content, updated_at = NOW()
                   FROM doc_revisions r
                  WHERE r.id = $1 AND r.status = 'pending' AND d.id = r.doc_id
                    AND d.title = r.base_title AND d.content = r.base_content
                 RETURNING d.id)
               ${mark} AND EXISTS (SELECT 1 FROM doc) RETURNING id`
            : `${mark} RETURNING id`;
        const updated = await pool.query(sql, values).catch((error: { code?: string }) => {
          if (error.code === '23505') return null;
          throw error;
        });
        if (!updated) {
          return void response.status(409).json({ message: 'Ein anderes Dokument trägt schon diesen Titel.' });
        }
        if (!updated.rows[0]) {
          const status = (
            await pool.query<{ status: string }>('SELECT status FROM doc_revisions WHERE id = $1', [request.params.id])
          ).rows[0]?.status;
          return void response.status(409).json({
            message:
              status === 'pending'
                ? 'Das Dokument wurde seit dieser Änderung geändert – die Änderung ist veraltet, bitte neu einreichen.'
                : 'Diese Änderung wurde bereits geprüft.',
          });
        }
        response.json({ status: decision, editor: hasRole(principal, 'editor') });
      } catch (error) {
        next(error);
      }
    };
  app.post('/doc-revisions/:id/approve', review('approved'));
  app.post('/doc-revisions/:id/reject', review('rejected'));
}
