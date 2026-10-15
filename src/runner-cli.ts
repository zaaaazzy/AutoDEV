import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createDatabasePool, readDatabaseConfig } from './database.js';
import { beatHeartbeat } from './worker.js';
import { parseRunnerOptions, runWorkflow, type RunnerOptions } from './runner.js';

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

async function main(): Promise<void> {
  const options = parseRunnerOptions(process.argv.slice(2));
  const pool = await connect(options.watch);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
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
    try {
      while (!stopping) {
        try {
          const targets = await resolveTargets(pool, options);
          known = targets.map((target) => target.options.project);
          beat();
          for (const target of targets) {
            const slug = target.options.project;
            if (target.problem) {
              errors.set(slug, target.problem);
              continue;
            }
            try {
              await runOnce(pool, target.options);
              errors.set(slug, null);
            } catch (error) {
              errors.set(slug, error instanceof Error ? error.message : String(error));
              console.error(`[${slug}] Runner-Zyklus fehlgeschlagen:`, errors.get(slug));
            }
          }
        } catch (error) {
          console.error('Worker-Zyklus fehlgeschlagen:', error instanceof Error ? error.message : error);
        }
        beat();
        for (let waited = 0; waited < options.intervalMs && !stopping; waited += 1000) {
          await sleep(1000);
        }
      }
    } finally {
      clearInterval(heartbeat);
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
