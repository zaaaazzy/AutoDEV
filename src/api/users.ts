import type { Router, Response } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isUuid } from '../core/validation.js';
import { type DevLogAuth, hashPassword } from './auth.js';
import { isRole, type Principal, ROLE_INFO, ROLES } from './roles.js';

/** Benutzerverwaltung (nur Administration; die Rollenprüfung erfolgt zentral in roles.ts). */
const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;
const MIN_PASSWORD = 12;
const COLUMNS = `id, username, display_name AS "displayName", roles, active, totp_secret IS NOT NULL AS totp,
  last_login_at AS "lastLoginAt", created_at AS "createdAt",
  ARRAY(SELECT m.project_slug FROM project_members m WHERE m.user_id = users.id ORDER BY m.project_slug) AS projects`;

/** Projektzugriff (Mandantentrennung): nur bestehende Projekte, doppelte entfernt. */
async function projectsFrom(pool: Pool, value: unknown): Promise<string[] | null | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500 || !value.every((slug) => typeof slug === 'string')) return null;
  const slugs = [...new Set(value as string[])];
  const known = (await pool.query<{ slug: string }>('SELECT slug FROM projects WHERE slug = ANY($1)', [slugs])).rows;
  return known.length === slugs.length ? slugs : null;
}

async function saveProjects(pool: Pool, userId: string, slugs: string[]): Promise<void> {
  await pool.query('DELETE FROM project_members WHERE user_id = $1 AND NOT (project_slug = ANY($2))', [userId, slugs]);
  await pool.query(
    `INSERT INTO project_members (user_id, project_slug) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [userId, slugs],
  );
}

function rolesFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const roles = [...new Set(value)];
  return roles.every(isRole) ? roles : null;
}

function passwordProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD) {
    return `Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`;
  }
  return value.length > 200 ? 'Das Passwort ist zu lang.' : null;
}

export function registerUserRoutes(app: Router, pool: Pool, auth: DevLogAuth | null): void {
  const me = (response: Response) => response.locals.principal as Principal;

  app.get('/users', access({ tenant: 'admin' }), async (_request, response, next) => {
    try {
      const users = (await pool.query(`SELECT ${COLUMNS} FROM users ORDER BY lower(username)`)).rows;
      response.json({
        users,
        systemAdmin: auth ? { username: auth.username, totp: Boolean(auth.totpSecret) } : null,
        roles: ROLES.map((role) => ({ id: role, ...ROLE_INFO[role] })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/users', access({ role: 'admin', tenant: 'admin' }), async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const roles = rolesFrom(body.roles ?? []);
      const problem = !USERNAME.test(username)
        ? 'Benutzername: 3–40 Zeichen, nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.'
        : auth && username.toLowerCase() === auth.username.toLowerCase()
          ? 'Dieser Benutzername ist für den Systemadministrator reserviert.'
          : !roles
            ? 'Unbekannte Rolle.'
            : passwordProblem(body.password);
      if (problem) {
        response.status(400).json({ message: problem });
        return;
      }
      const projects = await projectsFrom(pool, body.projects ?? []);
      if (projects === null) return void response.status(400).json({ message: 'Unbekanntes Projekt.' });
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 120) : '';
      const result = await pool
        .query(
          `INSERT INTO users (username, display_name, password_hash, roles) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
          [username, displayName, await hashPassword(body.password as string), roles],
        )
        .catch((error: { code?: string }) => {
          if (error.code === '23505') return null;
          throw error;
        });
      if (!result) {
        response.status(409).json({ message: 'Diesen Benutzernamen gibt es schon.' });
        return;
      }
      // Neue Benutzer sehen nur die freigeschalteten Projekte (Mandantentrennung).
      if (projects?.length) await saveProjects(pool, result.rows[0].id, projects);
      response.status(201).json({ user: { ...result.rows[0], projects: projects ?? [] } });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/users/:id', access({ role: 'admin', tenant: 'admin' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      const body = (request.body ?? {}) as Record<string, unknown>;
      const roles = body.roles === undefined ? undefined : rolesFrom(body.roles);
      if (roles === null) return void response.status(400).json({ message: 'Unbekannte Rolle.' });
      const projects = await projectsFrom(pool, body.projects);
      if (projects === null) return void response.status(400).json({ message: 'Unbekanntes Projekt.' });
      const self = me(response).id === request.params.id;
      if (self && ((roles && !roles.includes('admin')) || body.active === false)) {
        response.status(400).json({ message: 'Du kannst dir die Administration nicht selbst entziehen.' });
        return;
      }
      const result = await pool.query(
        `UPDATE users SET display_name = COALESCE($2, display_name), roles = COALESCE($3, roles),
                active = COALESCE($4, active), updated_at = NOW()
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [
          request.params.id,
          typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 120) : null,
          roles ?? null,
          typeof body.active === 'boolean' ? body.active : null,
        ],
      );
      if (!result.rows[0]) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      if (projects) {
        await saveProjects(pool, request.params.id, projects);
        result.rows[0].projects = projects.sort();
      }
      // Deaktivierte Benutzer werden sofort abgemeldet.
      if (body.active === false) await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [request.params.id]);
      response.json({ user: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.post('/users/:id/password', access({ role: 'admin', tenant: 'admin' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      const password = (request.body as { password?: unknown } | undefined)?.password;
      const problem = passwordProblem(password);
      if (problem) return void response.status(400).json({ message: problem });
      // Neues Passwort und Ende aller Sitzungen dieses Benutzers in einer Anweisung (also atomar). Die Sitzungen sind
      // zusätzlich an den Passwort-Hash gebunden und gälten auch ohne das Löschen nicht mehr.
      const result = await pool.query<{ id: string }>(
        `WITH changed AS (
           UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1 RETURNING id
         ), ended AS (
           DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM changed)
         )
         SELECT id FROM changed`,
        [request.params.id, await hashPassword(password as string)],
      );
      if (!result.rows.length) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      response.json({ updated: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/users/:id/totp/reset', access({ role: 'admin', tenant: 'admin' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      await pool.query('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = $1', [request.params.id]);
      response.json({ totp: false });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/users/:id', access({ role: 'admin', tenant: 'admin' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      if (me(response).id === request.params.id) {
        response.status(400).json({ message: 'Du kannst dich nicht selbst löschen.' });
        return;
      }
      await pool.query('DELETE FROM users WHERE id = $1', [request.params.id]);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}
