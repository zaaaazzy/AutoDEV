import type { Pool } from 'pg';
import { decryptSecret, isEncrypted } from '../core/secrets.js';

/** Alle Stellen, an denen mit DEV_LOG_SECRET_KEY verschlüsselte Werte liegen (Projektzugänge, TOTP-, VAPID-Schlüssel). */
const ENCRYPTED_VALUES = `
  SELECT 'projects.database_url' AS place, database_url AS value FROM projects WHERE database_url IS NOT NULL
  UNION ALL SELECT 'users.totp_secret', totp_secret FROM users WHERE totp_secret IS NOT NULL
  UNION ALL SELECT 'users.totp_pending', totp_pending FROM users WHERE totp_pending IS NOT NULL
  UNION ALL SELECT 'app_settings.' || key, value FROM app_settings
    WHERE key IN ('auth_totp_secret', 'auth_totp_pending', 'push_vapid_keys')`;

export interface SecretKeyCheck {
  /** Verschlüsselte Werte insgesamt. */
  encrypted: number;
  /** Davon mit dem gesetzten Schlüssel nicht lesbar, je Stelle gezählt (nie der Wert selbst). */
  unreadable: Record<string, number>;
}

/**
 * Entschlüsselungs-Test nach einem Restore: Jeder verschlüsselte Wert muss sich mit DEV_LOG_SECRET_KEY lesen lassen.
 * Gibt nur Zahlen zurück – weder Schlüssel noch Klartext verlassen die Funktion.
 */
export async function checkSecretKey(
  pool: Pool,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SecretKeyCheck> {
  const stored = (await pool.query<{ place: string; value: string }>(ENCRYPTED_VALUES)).rows;
  const rows = stored.filter((row) => isEncrypted(row.value));
  const unreadable: Record<string, number> = {};
  for (const row of rows) {
    try {
      decryptSecret(row.value, environment);
    } catch {
      unreadable[row.place] = (unreadable[row.place] ?? 0) + 1;
    }
  }
  return { encrypted: rows.length, unreadable };
}

/** Eine Zeile für das Restore-Skript; null = alles lesbar. */
export function secretKeyProblem(result: SecretKeyCheck, environment: NodeJS.ProcessEnv = process.env): string | null {
  const places = Object.entries(result.unreadable);
  if (!places.length) return null;
  const count = places.reduce((sum, [, n]) => sum + n, 0);
  const where = places.map(([place, n]) => `${place}: ${n}`).join(', ');
  const cause = environment.DEV_LOG_SECRET_KEY?.trim()
    ? 'DEV_LOG_SECRET_KEY passt nicht zu diesem Backup'
    : 'DEV_LOG_SECRET_KEY ist nicht gesetzt';
  return `${count} von ${result.encrypted} verschlüsselten Werten nicht lesbar (${where}) – ${cause}.`;
}
