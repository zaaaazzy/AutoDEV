import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { processChat } from './chat.js';
import { beginShutdown, killOrphan } from './shutdown.js';
import { createDatabasePool, readDatabaseConfig } from './database.js';
import { beatHeartbeat, readMaxAgents } from './worker.js';
import { parseRunnerOptions, runWorkflow, type RunnerOptions } from './runner.js';
import { analyzeBlocked } from './troubleshoot.js';

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function connect(watch: boolean): Promise<Pool> {
  for (;;) {
    try {
      return await createDatabasePool(readDatabaseConfig());
    } catch (error) {
      if (!watch) {
        throw error;
      }
      console.error('Datenbank nicht erreichbar, neuer Versuch in 15 s:', error instanceof Error ? error.message : error);
      await sleep(15_000);
    }
  }
}

async function runOnce(pool: Pool, options: RunnerOptions): Promise<boolean> {
  const results = await runWorkflow(pool, options);
  for (const { itemId, result } of results) {
    console.info(`${itemId}: ${result}`);
  }
  return results.some(({ result }) => result === 'failed');
}

interface Target {
  options: RunnerOptions;
  problem: string | null;
}

/** With --all every registered project is served from its own project folder (projects.repository). */
async function resolveTargets(pool: Pool, options: RunnerOptions): Promise<Target[]> {
  if (!options.all) {
    return [{ options, problem: null }];
  }
  const projects = await pool.query<{ slug: string; repository: string }>('SELECT slug, repository FROM projects ORDER BY slug');
  return projects.rows.map(({ slug, repository }) => {
    const folder = isAbsolute(repository) && existsSync(repository) && statSync(repository).isDirectory() ? repository : null;
    return {
      options: { ...options, project: slug, cwd: folder ?? options.cwd },
      problem: folder ? null : `Projektordner nicht gefunden: ${repository} (im Dev Log unter „Projekt“ den absoluten Pfad angeben)`,
    };
  });
}

// Läufe, die beim Beenden oder Absturz des Workers noch liefen, werden beendet und wieder eingeplant.
async function recoverInterruptedRuns(pool: Pool): Promise<void> {
  const orphans = await pool.query<{ pid: number; spawnedAt: Date }>(
    `SELECT pid, pid_started_at AS "spawnedAt" FROM agent_run_steps WHERE status = 'running' AND pid IS NOT NULL`);
  for (const orphan of orphans.rows) {
    if (killOrphan(orphan.pid, orphan.spawnedAt)) console.info(`Verwaisten Agent-Prozess ${orphan.pid} beendet.`);
  }
  const requeued = await pool.query(
    `UPDATE development_items SET status = 'planned', updated_at = NOW()
      WHERE status = 'in_progress' AND id IN (SELECT development_id FROM agent_runs WHERE status = 'running')`);
  await pool.query(`DELETE FROM chat_messages WHERE role = 'assistant' AND status = 'processing'`);
  await pool.query(`UPDATE chat_messages SET status = 'pending' WHERE status = 'processing'`);
  await pool.query(`UPDATE development_items SET analysis_status = 'requested' WHERE analysis_status = 'running'`);
  await pool.query(`UPDATE ideation_items SET status = 'requested', updated_at = NOW() WHERE status = 'drafting'`);
  await pool.query(`UPDATE agent_run_steps SET status = 'failed', output = output || E'\nUnterbrochen: Der Worker wurde beendet.' WHERE status = 'running'`);
  await pool.query(`UPDATE agent_runs SET status = 'failed', completed_at = NOW() WHERE status = 'running'`);
  if (requeued.rowCount) console.info(`${requeued.rowCount} unterbrochene Aufträge werden erneut aufgenommen.`);
}

async function main(): Promise<void> {
  const options = parseRunnerOptions(process.argv.slice(2));
  const pool = await connect(options.watch);
  let stopping = false;
  const stop = (): void => {
    if (stopping) process.exit(1);
    stopping = true;
    beginShutdown();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (!options.watch) {
      const targets = await resolveTargets(pool, options);
      let failed = false;
      for (const target of targets) {
        if (target.problem) {
          console.error(`[${target.options.project}] ${target.problem}`);
          continue;
        }
        failed = (await runOnce(pool, target.options)) || failed;
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    await recoverInterruptedRuns(pool);
    const intervalSeconds = Math.round(options.intervalMs / 1000);
    console.info(`Worker gestartet (${options.all ? 'alle Projekte' : options.project}, Intervall ${intervalSeconds} s).`);
    const errors = new Map<string, string | null>();
    let known: string[] = options.all ? [] : [options.project];
    let startup = true;
    const beat = (): void => {
      for (const slug of known) {
        void beatHeartbeat(pool, slug, intervalSeconds, errors.get(slug) ?? null, startup).catch(() => undefined);
      }
      if (known.length) startup = false;
    };
    const heartbeat = setInterval(beat, 15_000);
    // Chat-Antworten laufen unabhängig von Aufträgen, damit der Assistent sofort reagiert.
    let chatTargets: Target[] = [];
    const chatActive = new Set<string>();
    const chatTimer = setInterval(() => {
      for (const target of chatTargets) {
        const slug = target.options.project;
        if (target.problem || chatActive.has(slug) || stopping) continue;
        chatActive.add(slug);
        void processChat(pool, target.options)
          .then(() => analyzeBlocked(pool, target.options))
          .catch((error: unknown) => console.error(`[${slug}] Chat fehlgeschlagen:`, error instanceof Error ? error.message : error))
          .finally(() => chatActive.delete(slug));
      }
    }, 1500);
    // Each project runs in its own task; at most "maxConcurrentAgents" tasks run at the same time.
    const active = new Map<string, Promise<void>>();
    const lastStart = new Map<string, number>();
    const runTarget = async (target: Target): Promise<void> => {
      const slug = target.options.project;
      try {
        await runOnce(pool, target.options);
        errors.set(slug, null);
      } catch (error) {
        errors.set(slug, error instanceof Error ? error.message : String(error));
        console.error(`[${slug}] Runner-Zyklus fehlgeschlagen:`, errors.get(slug));
      }
    };
    try {
      while (!stopping) {
        try {
          const targets = await resolveTargets(pool, options);
          known = targets.map((target) => target.options.project);
          chatTargets = targets;
          beat();
          const limit = await readMaxAgents(pool);
          // The project that waited longest goes first, so no project starves when slots are scarce.
          targets.sort((a, b) => (lastStart.get(a.options.project) ?? 0) - (lastStart.get(b.options.project) ?? 0));
          for (const target of targets) {
            const slug = target.options.project;
            if (target.problem) {
              errors.set(slug, target.problem);
              continue;
            }
            if (active.has(slug) || active.size >= limit) {
              continue;
            }
            lastStart.set(slug, Date.now());
            const task = runTarget(target).finally(() => active.delete(slug));
            active.set(slug, task);
          }
        } catch (error) {
          console.error('Worker-Zyklus fehlgeschlagen:', error instanceof Error ? error.message : error);
        }
        beat();
        for (let waited = 0; waited < options.intervalMs && !stopping; waited += 1000) {
          await sleep(1000);
        }
      }
      await Promise.all(active.values());
      while (chatActive.size) await sleep(200);
    } finally {
      clearInterval(heartbeat);
      clearInterval(chatTimer);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Runner failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
