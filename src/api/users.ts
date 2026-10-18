import type { Express, Response } from 'express';
import type { Pool } from 'pg';
import { isUuid } from '../core/validation.js';
import { type DevLogAuth, hashPassword } from './auth.js';
import { isRole, type Principal, ROLE_INFO, ROLES } from './roles.js';

/** Benutzerverwaltung (nur Administration; die Rollenprüfung erfolgt zentral in roles.ts). */
const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;
const MIN_PASSWORD = 12;
const COLUMNS = `id, username, display_name AS "displayName", roles, active, totp_secret IS NOT NULL AS totp,
  last_login_at AS "lastLoginAt", created_at AS "createdAt"`;

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

export function registerUserRoutes(app: Express, pool: Pool, auth: DevLogAuth | null): void {
  const me = (response: Response) => response.locals.principal as Principal;

  app.get('/api/users', async (_request, response, next) => {
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

  app.post('/api/users', async (request, response, next) => {
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
      response.status(201).json({ user: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/users/:id', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      const body = (request.body ?? {}) as Record<string, unknown>;
      const roles = body.roles === undefined ? undefined : rolesFrom(body.roles);
      if (roles === null) return void response.status(400).json({ message: 'Unbekannte Rolle.' });
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
      // Deaktivierte Benutzer werden sofort abgemeldet.
      if (body.active === false) await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [request.params.id]);
      response.json({ user: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/users/:id/password', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      const password = (request.body as { password?: unknown } | undefined)?.password;
      const problem = passwordProblem(password);
      if (problem) return void response.status(400).json({ message: problem });
      const result = await pool.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [
        request.params.id,
        await hashPassword(password as string),
      ]);
      if (!result.rowCount) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      // Neues Passwort: alle Sitzungen dieses Benutzers beenden.
      await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [request.params.id]);
      response.json({ updated: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/users/:id/totp/reset', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Benutzer nicht gefunden.' });
      await pool.query('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = $1', [request.params.id]);
      response.json({ totp: false });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/users/:id', async (request, response, next) => {
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
