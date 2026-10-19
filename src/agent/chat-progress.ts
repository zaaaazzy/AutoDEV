import type { Pool } from 'pg';
import { logged } from '../core/log.js';

const INTERVAL_MS = 8000;

/** Zeigt im Chat eine Zwischenmeldung mit Laufzeit, bis `stop()` sie wieder entfernt. */
export async function startProgress(
  pool: Pool,
  project: string,
  stages: string[],
  link: { stepId?: string; silent?: boolean } = {},
): Promise<{ update: (message: string) => void; stop: () => Promise<void> }> {
  const started = Date.now();
  let override = '';
  const text = (): string => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const stage = override || stages[Math.min(stages.length - 1, Math.floor(seconds / 15))] || 'Arbeite …';
    return `${stage} (${seconds} s)`;
  };
  const writeStep = (value: string | null): Promise<unknown> =>
    link.stepId
      ? pool
          .query('UPDATE agent_run_steps SET progress = $2 WHERE id = $1', [link.stepId, value])
          .catch(logged(`progress:${project}`))
      : Promise.resolve();
  void writeStep(text());
  if (link.silent) {
    const ticker = setInterval(() => void writeStep(text()), INTERVAL_MS);
    return {
      update: (message) => {
        override = message;
        void writeStep(text());
      },
      stop: async () => {
        clearInterval(ticker);
        await writeStep(null);
      },
    };
  }
  const id = (
    await pool
      .query<{ id: string }>(
        `INSERT INTO chat_messages (project_slug, role, content, status)
     VALUES ($1, 'assistant', $2, 'processing') RETURNING id`,
        [project, text()],
      )
      .catch(logged(`progress:${project}`, { rows: [] as { id: string }[] }))
  ).rows[0]?.id;
  if (!id) return { update: () => undefined, stop: async () => undefined };
  const timer = setInterval(() => {
    void pool
      .query(`UPDATE chat_messages SET content = $2 WHERE id = $1`, [id, text()])
      .catch(logged(`progress:${project}`));
    void writeStep(text());
  }, INTERVAL_MS);
  return {
    update: (message) => {
      override = message;
      void pool
        .query(`UPDATE chat_messages SET content = $2 WHERE id = $1`, [id, text()])
        .catch(logged(`progress:${project}`));
      void writeStep(text());
    },
    stop: async () => {
      clearInterval(timer);
      await writeStep(null);
      await pool.query(`DELETE FROM chat_messages WHERE id = $1`, [id]).catch(logged(`progress:${project}`));
    },
  };
}
