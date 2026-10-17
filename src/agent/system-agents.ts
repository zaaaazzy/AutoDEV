import type { Pool } from 'pg';
import { resolveModel } from './ollama-client.js';

export interface SystemAgent {
  name: string;
  description: string;
  role: string;
  model: string;
  envKey: string;
}

const ROLES = [
  ['Dashboard-Assistent', 'Beantwortet Chat-Fragen, prüft Dienste und löst Probleme im Projektumfang.', 'assistant'],
  ['Problemanalyse', 'Analysiert blockierte Aufträge und schlägt Lösungen vor.', 'analyst'],
  ['Schnellschätzung', 'Schätzt Aufwand und Nutzen neuer Ideen (Auftragsautor-Modell).', 'author'],
] as const;

export function systemAgents(environment: NodeJS.ProcessEnv = process.env): SystemAgent[] {
  return ROLES.map(([name, description, role]) => ({
    name,
    description,
    role,
    model: resolveModel(role, environment),
    envKey: `DEV_LOG_OLLAMA_MODEL_${role.toUpperCase()}`,
  }));
}

/** The worker resolves the models (it owns the environment) and publishes them for the dashboard. */
export async function publishSystemAgents(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('system_agents', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(systemAgents())],
  );
}
