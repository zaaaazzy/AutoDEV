import type { Pool } from 'pg';

const INTERVAL_MS = 8000;

/** Zeigt im Chat eine Zwischenmeldung mit Laufzeit, bis `stop()` sie wieder entfernt. */
export async function startProgress(
  pool: Pool,
  project: string,
  stages: string[],
  link: { developmentId?: string; agentName?: string } = {},
): Promise<() => Promise<void>> {
  const started = Date.now();
  const text = (): string => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const stage = stages[Math.min(stages.length - 1, Math.floor(seconds / 15))] ?? 'Arbeite …';
    return `${stage} (${seconds} s)`;
  };
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO chat_messages (project_slug, role, content, status, development_id, agent_name)
     VALUES ($1, 'assistant', $2, 'processing', $3, $4) RETURNING id`,
    [project, text(), link.developmentId ?? null, link.agentName ?? null],
  ).catch(() => ({ rows: [] }))).rows[0]?.id;
  if (!id) return async () => undefined;
  const timer = setInterval(() => {
    void pool.query(`UPDATE chat_messages SET content = $2 WHERE id = $1`, [id, text()]).catch(() => undefined);
  }, INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    await pool.query(`DELETE FROM chat_messages WHERE id = $1`, [id]).catch(() => undefined);
  };
}
