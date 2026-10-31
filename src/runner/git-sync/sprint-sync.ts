// Sprint-Sicherung: Commits, Test-Gate, Push, Merge nach main, Pull Requests und Live schalten.
import type { Pool } from 'pg';
import { acquireTree, withProjectLock } from '../../core/project-lock.js';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import { isShuttingDown } from '../../core/shutdown.js';
import { createGithubAdapter, githubRepo } from '../github.js';
import type { HosterAdapter } from '../hoster.js';
import { loadTestCommands } from '../runner-selection.js';
import { requestRestart } from '../system-restart.js';
import {
  BOT_IDENTITY,
  branchExists,
  checkedOutElsewhere,
  currentBranch,
  ensureRepository,
  freshestMain,
  gitHelpers,
  type GitHelpers,
  MAIN_BRANCH,
  mainContains,
  pushRemote,
  sprintBranchOf,
  sprintTag,
  stageAll,
  taskCommitMessage,
} from './git-helpers.js';
import { ensureCiWorkflow, runTestGate, waitForCi } from './ci.js';
import { orderWorkInProgress } from './order-branch.js';
import { gitEnvironment } from '../project-command.js';
import { gateExecutor } from '../test-sandbox.js';
import { DEVELOPMENT_STATUS, SPRINT_STATUS } from '../../core/status.js';

/** Erstellt nach einem erledigten Sprint-Auftrag einen lokalen Commit (kein Push; den übernimmt die Sprint-Sicherung). */
export async function commitTaskToGit(
  cwd: string,
  item: { id: string; title: string; kind?: string },
  sprintName: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<string | null> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  try {
    await ensureRepository(git, must, cwd);
    await stageAll(git, must);
    if (!(await must('diff', '--cached', '--name-only'))) return null;
    const [subject, body] = taskCommitMessage(item.kind, sprintName, item.title, item.id);
    await must('commit', '--no-verify', '-m', subject, '-m', body);
    return await must('rev-parse', '--short', 'HEAD');
  } catch (error) {
    console.error(
      `Auftrags-Commit für ${item.id} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Erst-Commit beim Verbinden eines Projekts: Repository bei Bedarf anlegen, interne Ordner und .env ausschliessen und
 * Dateien, die nach Zugangsdaten aussehen, zurückhalten – bevor irgendetwas gepusht wird.
 */
export async function commitProjectSetup(
  cwd: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<{ initialized: boolean; committed: boolean; held: string[] }> {
  const { git, must } = gitHelpers(rawExecute, cwd);
  const initialized = await ensureRepository(git, must, cwd);
  const hasCommit = (await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode === 0;
  const log: string[] = [];
  const held = await stageAll(git, must, log);
  const staged = Boolean(await must('diff', '--cached', '--name-only'));
  if (!staged && hasCommit) return { initialized, committed: false, held };
  await must(
    'commit',
    '--no-verify',
    '--allow-empty',
    '-m',
    hasCommit ? 'chore: Projekt mit AIdeation verbunden' : 'chore: Initial-Commit',
  );
  return { initialized, committed: true, held };
}

interface PendingSprint {
  id: string;
  name: string;
  /** Beim Start festgehaltener Sprint-Branch (sprints.branch); unabhängig vom aktuellen Namen. */
  branch?: string | null;
  /** Der Sprint hat erledigte Aufträge: Dann muss es seinen Branch geben. */
  hasDone?: boolean;
  action: 'push' | 'pull' | null;
  remote: string | null;
  status: string;
  prUrl?: string | null;
}

/** PR-Modus beim Sprint-Abschluss: Adapter des Hosters, Sprintbericht als Text und ein schon offener Pull Request. */
interface PullRequestPlan {
  adapter: HosterAdapter;
  body: string;
  existing: string | null;
}

async function configureOrigin(git: GitHelpers['git'], must: GitHelpers['must'], remote: string): Promise<void> {
  const current = await git('remote', 'get-url', 'origin');
  const target = pushRemote(remote);
  await must(
    ...(current.exitCode === 0 ? ['remote', 'set-url', 'origin', target] : ['remote', 'add', 'origin', target]),
  );
}

interface SyncResult {
  commit: string;
  branch: string;
  log: string[];
  /** Der Sprint wurde in diesem Lauf nach main gemergt. */
  mergedMain?: boolean;
  /** main liegt in einem anderen Ordner mit offenen Änderungen: Dort übernimmt ein Mensch den Sprint („wartet auf Merge“). */
  awaitingMerge?: boolean;
  /** PR-Modus: Link des geöffneten Pull Requests; Merge und Tag folgen nach grüner CI. */
  pullRequest?: string;
}

/**
 * Sichert den Sprint-Branch: Reständerungen committen, Projekttests ausführen (Test-Gate) und nur bei grünen Tests pushen.
 * Ist der Sprint abgeschlossen, wird der Sprint-Branch danach mit --no-ff nach main gemergt, erneut getestet und gepusht.
 */
async function pushSprint(
  helpers: GitHelpers,
  sprint: PendingSprint,
  log: string[],
  gate: (log: string[]) => Promise<void>,
  ci: {
    cwd: string;
    commands: string[][];
    execute: CommandExecutor;
    /** Führt die Testbefehle des Gates in einem Ordner aus (Testcontainer der Sandbox); Standard: execute. */
    testExecutor?: (folder: string) => Promise<CommandExecutor>;
    pullRequest?: PullRequestPlan | null;
  },
): Promise<SyncResult> {
  const { git, must } = helpers;
  const branch = sprintBranchOf(sprint);
  let mergedMain = false;
  let awaitingMerge = false;
  if (await branchExists(git, branch)) {
    if ((await must('rev-parse', '--abbrev-ref', 'HEAD')) !== branch) await must('checkout', branch);
  } else if (sprint.status === SPRINT_STATUS.completed && sprint.hasDone) {
    // Erledigte Aufträge, aber kein Sprint-Branch: Früher wurde dann der aktuelle Branch gesichert, getaggt und „done“
    // gemeldet – main bekam die Aufträge nie, der Tag zeigte auf einen fremden Stand.
    throw new Error(
      `Sprint-Branch ${branch} fehlt, obwohl der Sprint erledigte Aufträge hat – nichts nach ${MAIN_BRANCH} übernommen. Branch wiederherstellen, dann „Git-Sicherung“ erneut starten.`,
    );
  } else if ((await currentBranch(git)) === 'HEAD') {
    // Losgelöst (Agent-Worktree): Ohne Branch landete der Sicherungs-Commit nur am Tag und nie in main.
    await must('checkout', '-b', branch);
    log.push(`Kein Sprint-Branch vorhanden – ${branch} aus dem aktuellen Stand angelegt.`);
  } else {
    log.push(`Kein Sprint-Branch ${branch} – sichere den aktuellen Branch.`);
  }
  await stageAll(git, must, log);
  if (await must('diff', '--cached', '--name-only')) {
    await must(
      'commit',
      '--no-verify',
      '-m',
      `chore(${sprint.name}): Sprint-Stand sichern`,
      '-m',
      'Automatisch gesichert vom AIdeation.',
    );
    log.push('Reständerungen committet.');
  }
  // Geprüft wird der Stand, der live geht: aktuellen main in den Sprint-Branch übernehmen (z. B. Korrekturen, die
  // nach dem Sprintstart auf main kamen). Konflikte brechen ab, statt etwas Ungeprüftes zu mergen.
  if (sprint.status === SPRINT_STATUS.completed && (await branchExists(git, MAIN_BRANCH))) {
    const head = await must('rev-parse', '--abbrev-ref', 'HEAD');
    if (head !== MAIN_BRANCH && (await git('merge-base', '--is-ancestor', MAIN_BRANCH, 'HEAD')).exitCode !== 0) {
      const merged = await git('merge', '--no-edit', MAIN_BRANCH, '-m', `Merge ${MAIN_BRANCH} in ${head}`);
      if (merged.exitCode !== 0) {
        await git('merge', '--abort');
        throw new Error(
          `${MAIN_BRANCH} lässt sich nicht konfliktfrei in ${head} übernehmen – bitte zusammenführen. ${merged.output.slice(-300)}`,
        );
      }
      log.push(`Aktuellen ${MAIN_BRANCH} in ${head} übernommen.`);
    }
  }
  if (sprint.remote && /github\.com/.test(sprint.remote)) await ensureCiWorkflow(ci.cwd, ci.commands, helpers, log);
  await gate(log);
  let current = await must('rev-parse', '--abbrev-ref', 'HEAD');
  if (sprint.remote) {
    await must('push', '-u', 'origin', current);
    log.push(`${current} nach GitHub gepusht.`);
  }
  if (sprint.status === SPRINT_STATUS.review) {
    // Nachbesserung im Review: der Push aktualisiert den Pull Request; der Tag folgt erst nach dem Merge.
    log.push('Sprint im Review: Pull Request aktualisiert, Merge und Tag folgen nach grüner CI.');
    return { commit: await must('rev-parse', '--short', 'HEAD'), branch: current, log };
  }
  if (sprint.status === SPRINT_STATUS.completed && current === branch && ci.pullRequest && sprint.remote) {
    // PR-Modus: statt direkt zu mergen einen Pull Request öffnen; den Merge übernimmt pollSprintReviews.
    const { adapter, body, existing } = ci.pullRequest;
    const url =
      existing ??
      (await adapter.findPullRequest(branch)) ??
      (await adapter.createPullRequest({ head: branch, base: MAIN_BRANCH, title: `Sprint: ${sprint.name}`, body }));
    log.push(`Pull Request ${url} geöffnet – Merge nach ${MAIN_BRANCH} und Tag folgen nach grüner CI.`);
    return { commit: await must('rev-parse', '--short', 'HEAD'), branch: current, log, pullRequest: url };
  }
  if (sprint.status === SPRINT_STATUS.completed && current === branch) {
    if (sprint.remote) await waitForCi(ci.execute, ci.cwd, branch, log);
    const elsewhere = await checkedOutElsewhere(git, MAIN_BRANCH, ci.cwd);
    if (elsewhere) {
      // main ist im Arbeitsordner der Menschen ausgecheckt: dort übernehmen, aber nur, wenn er sauber auf main steht
      // (Test-Gate dort, bei Rot zurückgenommen). Offene Änderungen dort: Der Sprint wartet auf den Merge von Hand;
      // Konflikte oder rotes Test-Gate: gescheitert. Früher hiess beides „done“, obwohl nichts in main war, und der
      // nächste Sprint zweigte vom alten main ab (Arbeit gestrandet).
      const outcome = await mergeIntoCheckedOutMain(
        ci.execute,
        elsewhere,
        branch,
        sprint.name,
        ci.commands,
        log,
        await ci.testExecutor?.(elsewhere),
      );
      if (outcome === 'failed') {
        throw new Error(
          `${log.at(-1) ?? `${branch} konnte nicht nach ${MAIN_BRANCH} übernommen werden.`} Der Sprint ist noch nicht in ${MAIN_BRANCH}; nach dem Aufräumen „Git-Sicherung“ erneut starten.`,
        );
      }
      mergedMain = outcome === 'merged';
      awaitingMerge = outcome === 'busy';
      if (mergedMain && sprint.remote) {
        const pushed = await ci.execute(['git', 'push', '-u', 'origin', MAIN_BRANCH], elsewhere, {
          timeoutMs: 120_000,
          env: gitEnvironment({
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
          }),
        });
        if (pushed.exitCode !== 0) {
          throw new Error(
            `Sprint in ${elsewhere} nach ${MAIN_BRANCH} gemergt, aber der Push nach GitHub ist fehlgeschlagen: ${pushed.output.trim().slice(-300)}`,
          );
        }
        log.push(`${MAIN_BRANCH} nach GitHub gepusht.`);
      }
      // Agent-Ordner nicht auf dem abgeschlossenen Sprint-Branch stehen lassen: Aufträge ohne Sprint (Erneut versuchen,
      // Bugfix, einzelner Agent) zweigten sonst davon ab und landeten dort statt in main. Losgelöst, weil main drüben
      // ausgecheckt ist; der Ordner ist sauber (oben committet).
      const detached = await git('checkout', '--detach', MAIN_BRANCH);
      log.push(
        detached.exitCode === 0
          ? `Agent-Ordner losgelöst auf ${MAIN_BRANCH}.`
          : `Agent-Ordner bleibt auf ${branch}: ${detached.output.slice(-200)}`,
      );
    } else if (await branchExists(git, MAIN_BRANCH)) {
      await must('checkout', MAIN_BRANCH);
      const before = await must('rev-parse', 'HEAD');
      const merged = await git('merge', '--no-ff', branch, '-m', `Merge ${branch}: Sprint ${sprint.name}`);
      if (merged.exitCode !== 0) {
        await git('merge', '--abort');
        await must('checkout', branch);
        throw new Error(
          `Merge von ${branch} nach ${MAIN_BRANCH} hat Konflikte – bitte manuell zusammenführen. ${merged.output.slice(-300)}`,
        );
      }
      try {
        await gate(log);
      } catch (error) {
        // Rotes Test-Gate: main nicht mit dem ungeprüften Merge stehen lassen (neue Sprints zweigen von main ab).
        const reset = await git('reset', '--keep', before);
        if (reset.exitCode === 0) await git('checkout', branch);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ${
            reset.exitCode === 0
              ? `Merge nach ${MAIN_BRANCH} zurückgenommen.`
              : `ACHTUNG: Merge nach ${MAIN_BRANCH} konnte nicht zurückgenommen werden (${reset.output.slice(-200)}) – ${MAIN_BRANCH} von Hand auf ${before.slice(0, 7)} zurücksetzen.`
          }`,
          { cause: error },
        );
      }
    } else {
      await must('branch', '-m', branch, MAIN_BRANCH);
    }
    if (!elsewhere) {
      mergedMain = true;
      current = MAIN_BRANCH;
      log.push(`Sprint abgeschlossen: ${branch} nach ${MAIN_BRANCH} gemergt.`);
      if (sprint.remote) await must('push', '-u', 'origin', MAIN_BRANCH);
    }
  }
  const tag = sprintTag(sprint.name, sprint.id);
  await must('tag', '-f', tag, ...(awaitingMerge ? [branch] : []));
  if (sprint.remote) {
    await must('push', '--force', 'origin', `refs/tags/${tag}`);
    log.push(`Tag ${tag} gepusht.`);
  } else {
    log.push('Kein GitHub-Repository am Projekt hinterlegt – nur lokal gesichert.');
  }
  // Nach dem Loslösen steht HEAD auf main: der Stand, auf den main warten muss, ist der Sprint-Branch.
  return {
    commit: await must('rev-parse', '--short', awaitingMerge ? branch : 'HEAD'),
    branch: current,
    log,
    mergedMain,
    awaitingMerge,
  };
}

/**
 * Übernimmt den Sprint in main, das in einem anderen Ordner (dem Arbeitsordner der Menschen) ausgecheckt ist. Nur
 * wenn dort keine offenen Änderungen liegen und main ausgecheckt ist; danach läuft das Test-Gate dort. Scheitert es,
 * wird der Merge mit `git reset --keep` zurückgenommen (verliert nie lokale Änderungen).
 */
export async function mergeIntoCheckedOutMain(
  execute: CommandExecutor,
  folder: string,
  branch: string,
  sprintName: string,
  commands: string[][],
  log: string[],
  /** Testbefehle des Gates (Testcontainer der Sandbox); Git läuft weiter über execute auf dem Host. */
  testExecute: CommandExecutor = execute,
): Promise<'merged' | 'busy' | 'failed'> {
  const git = (...args: string[]) =>
    execute(['git', ...args], folder, { timeoutMs: 120_000, env: gitEnvironment(BOT_IDENTITY) });
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const status = await git('status', '--porcelain', '--untracked-files=no');
  if (head.exitCode !== 0 || head.output.trim() !== MAIN_BRANCH || status.exitCode !== 0 || status.output.trim()) {
    log.push(
      `Sprint abgeschlossen: ${branch} ist bereit, aber noch nicht in ${MAIN_BRANCH}. In ${folder} sind Änderungen offen oder nicht ${MAIN_BRANCH} ausgecheckt – dort mit „git merge ${branch}“ übernehmen; bis dahin startet der Autopilot keinen neuen Sprint, kein automatischer Neustart.`,
    );
    return 'busy';
  }
  const before = (await git('rev-parse', 'HEAD')).output.trim();
  const merged = await git('merge', '--no-ff', branch, '-m', `Merge ${branch}: Sprint ${sprintName}`);
  if (merged.exitCode !== 0) {
    await git('merge', '--abort');
    log.push(`Merge von ${branch} nach ${MAIN_BRANCH} in ${folder} hat Konflikte – bitte manuell zusammenführen.`);
    return 'failed';
  }
  try {
    await runTestGate(testExecute, folder, commands, log);
  } catch (error) {
    // Auf den Stand vor dem Merge (nicht ORIG_HEAD: den können Befehle des Test-Gates verschoben haben).
    const reset = await git('reset', '--keep', before);
    const detail = error instanceof Error ? error.message : '';
    log.push(
      reset.exitCode === 0
        ? `Test-Gate nach dem Merge in ${folder} rot – Merge zurückgenommen. ${detail}`.trim()
        : `Test-Gate nach dem Merge in ${folder} rot – ACHTUNG: Merge konnte nicht zurückgenommen werden (${reset.output.trim().slice(-200)}); ${MAIN_BRANCH} dort von Hand auf ${before.slice(0, 7)} zurücksetzen. ${detail}`.trim(),
    );
    return 'failed';
  }
  log.push(`Sprint abgeschlossen: ${branch} in ${folder} nach ${MAIN_BRANCH} gemergt.`);
  return 'merged';
}

/** Holt den Stand von GitHub per Fast-Forward; lokale Änderungen oder abweichende Historie brechen mit Fehlermeldung ab. */
async function pullSprint(helpers: GitHelpers, sprint: PendingSprint, log: string[]): Promise<SyncResult> {
  const { must } = helpers;
  if (!sprint.remote) {
    throw new Error('Kein GitHub-Repository am Projekt hinterlegt.');
  }
  const branch = await must('rev-parse', '--abbrev-ref', 'HEAD');
  await must('pull', '--ff-only', 'origin', branch);
  log.push('Stand von GitHub geladen.');
  return { commit: await must('rev-parse', '--short', 'HEAD'), branch, log };
}

/**
 * Live schalten nach dem Merge nach main und das Ergebnis protokollieren. Erfolg nur, wenn der Deploy nicht
 * gescheitert ist (deployProject meldet das mit false statt zu werfen).
 */
export async function goLiveLogged(onMergedMain: () => Promise<boolean | null | void>, log: string[]): Promise<void> {
  try {
    const deployed = await onMergedMain();
    log.push(
      deployed === false
        ? 'Live schalten unvollständig: Deploy fehlgeschlagen (Details im Deploy-Status des Projekts).'
        : deployed === null
          ? 'Live geschaltet: Projektordner auf main nachgezogen (keine Deploy-Befehle hinterlegt).'
          : 'Live geschaltet: Projektordner auf main nachgezogen und deployt.',
    );
  } catch (error) {
    log.push(`Live schalten unvollständig: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sprints, die auf den Merge nach main warten: „done“, sobald main (lokal oder der neuere Stand auf GitHub) den
 * vermerkten Sprint-Stand enthält. Scheitert die Prüfung selbst, gilt die Sicherung als gescheitert – das ist weder
 * „fertig“ noch „wartet“, und der Autopilot pausiert mit Begründung.
 */
async function settleAwaitingMerge(pool: Pool, project: string, git: GitHelpers['git']): Promise<void> {
  const waiting = (
    await pool.query<{ id: string; name: string; commit: string | null }>(
      `SELECT id, name, git_commit AS commit FROM sprints WHERE project_slug = $1 AND git_sync = 'awaiting_merge'`,
      [project],
    )
  ).rows;
  if (!waiting.length) return;
  const main = await freshestMain(git);
  for (const sprint of waiting) {
    try {
      if (!sprint.commit) throw new Error('kein Sprint-Stand vermerkt.');
      if (!(await mainContains(git, sprint.commit, main))) continue;
      await pool.query(
        `UPDATE sprints SET git_sync = 'done', git_message = concat_ws(' ', git_message, $2::text), git_synced_at = NOW()
          WHERE id = $1 AND git_sync = 'awaiting_merge'`,
        [sprint.id, `Inzwischen in ${MAIN_BRANCH} übernommen.`],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pool.query(
        `UPDATE sprints SET git_sync = 'failed', git_message = $2, git_synced_at = NOW()
          WHERE id = $1 AND git_sync = 'awaiting_merge'`,
        [sprint.id, `Ob ${MAIN_BRANCH} „${sprint.name}“ enthält, liess sich nicht prüfen: ${message}`.slice(0, 1500)],
      );
    }
  }
}

/** Works through the next queued Git request (push or pull) of the project's sprints. */
export async function syncSprintToGit(
  pool: Pool,
  project: string,
  cwd: string,
  rawExecute: CommandExecutor = runCommand,
  /** Nach dem Merge nach main („Live schalten“): Live-Ordner nachziehen und deployen (Ergebnis wie goLive). */
  onMergedMain?: () => Promise<boolean | null | void>,
): Promise<number> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  await pool.query(
    // Hängengebliebene Sicherung (Worker abgestürzt) nach einer Stunde wieder einreihen; das Test-Gate dauert höchstens
    // 45 Minuten. updated_at setzt der Claim unten – vorher wurde es nie aktualisiert und der Reset griff sofort.
    `UPDATE sprints SET git_sync = 'pending' WHERE project_slug = $1 AND git_sync = 'running'
        AND updated_at < NOW() - INTERVAL '60 minutes'`,
    [project],
  );
  await settleAwaitingMerge(pool, project, gitHelpers(execute, cwd).git);
  // Ein unterbrochener Auftrag (z. B. durch einen Neustart) steht noch mit offenen Änderungen auf seinem Branch und
  // läuft gleich weiter. Die Git-Sicherung wartet (bleibt „pending“), statt am Checkout zu scheitern; sie läuft am
  // Ende desselben Durchlaufs erneut.
  if (await orderWorkInProgress(cwd, execute)) return 0;
  const claimed = await pool.query<PendingSprint>(
    `UPDATE sprints s SET git_sync = 'running', updated_at = NOW()
      WHERE s.id = (SELECT id FROM sprints WHERE project_slug = $1 AND git_sync = 'pending'
                     ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING s.id, s.name, s.branch, s.status, s.git_action AS action, s.pr_url AS "prUrl",
                EXISTS (SELECT 1 FROM development_items d WHERE d.sprint_id = s.id AND d.status = '${DEVELOPMENT_STATUS.done}') AS "hasDone",
                (SELECT git_remote FROM projects WHERE slug = s.project_slug) AS remote`,
    [project],
  );
  const sprint = claimed.rows[0];
  if (!sprint) {
    return 0;
  }
  const helpers = gitHelpers(execute, cwd);
  const log: string[] = [];
  // Checkout, „Sprint-Stand sichern“ und Merge exklusiv: kein Assistent schreibt dazwischen in den Ordner.
  const releaseTree = await acquireTree(cwd);
  try {
    if (await ensureRepository(helpers.git, helpers.must, cwd)) {
      log.push('Repository initialisiert.');
    }
    if (sprint.remote) {
      await configureOrigin(helpers.git, helpers.must, sprint.remote);
    }
    const commands = await loadTestCommands(pool, project);
    const restartAfterSprint =
      (
        await pool
          .query<{ restart: boolean }>('SELECT restart_after_sprint AS restart FROM projects WHERE slug = $1', [
            project,
          ])
          .catch(() => ({ rows: [] as { restart: boolean }[] }))
      ).rows[0]?.restart === true;
    // Projekttests des Gates im Testcontainer (Sandbox, Standard); im Notfallmodus „off“ wie bisher auf dem Host.
    const testExecutor = (folder: string): Promise<CommandExecutor> =>
      gateExecutor(pool, project, folder, rawExecute, `gate-${sprint.id}`);
    const gate = async (entries: string[]) => runTestGate(await testExecutor(cwd), cwd, commands, entries);
    const pullRequest =
      sprint.action === 'pull' ? null : await planPullRequest(pool, project, sprint, cwd, rawExecute, log);
    const result =
      sprint.action === 'pull'
        ? await pullSprint(helpers, sprint, log)
        : await pushSprint(helpers, sprint, log, gate, {
            cwd,
            commands,
            execute: rawExecute,
            testExecutor,
            pullRequest,
          });
    if (result.pullRequest) {
      await pool.query(
        `UPDATE sprints SET status = '${SPRINT_STATUS.review}', pr_url = $5, ci_status = 'pending', ci_bug_run = NULL, git_sync = 'done',
                git_message = $2, git_commit = $3, git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
        [sprint.id, result.log.join(' '), result.commit, result.branch, result.pullRequest],
      );
      return 1;
    }
    // Abgeschlossen heisst „in main“: Fehlt der Sprint dort noch (main in anderem Ordner mit offenen Änderungen), wartet
    // er auf den Merge – kein „done“, kein Live schalten, kein Neustart, und der Autopilot startet keinen neuen Sprint.
    if (sprint.status === SPRINT_STATUS.completed && sprint.action !== 'pull') {
      const branch = sprintBranchOf(sprint);
      const waiting =
        result.awaitingMerge ||
        ((await branchExists(helpers.git, branch)) &&
          (await branchExists(helpers.git, MAIN_BRANCH)) &&
          !(await mainContains(helpers.git, branch)));
      if (waiting) {
        await pool.query(
          `UPDATE sprints SET git_sync = 'awaiting_merge', git_message = $2, git_commit = $3, git_branch = $4,
                  git_synced_at = NOW() WHERE id = $1`,
          [sprint.id, result.log.join(' '), await helpers.must('rev-parse', '--short', branch), branch],
        );
        return 1;
      }
    }
    if (result.mergedMain && onMergedMain) await goLiveLogged(onMergedMain, result.log);
    if (result.mergedMain && restartAfterSprint) {
      const { created } = await requestRestart(
        pool,
        'Sprint-Abschluss',
        new Date(),
        `Automatisch nach dem Sprint „${sprint.name}“ (in main übernommen).`,
      );
      result.log.push(created ? 'Neustart von AIdeation angefordert.' : 'Ein Neustart läuft bereits.');
    }
    await pool.query(
      `UPDATE sprints SET git_sync = 'done', git_message = $2, git_commit = $3, git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
      [sprint.id, result.log.join(' '), result.commit, result.branch],
    );
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Worker wird beendet (Neustart): Das Test-Gate wurde abgeschossen, nicht rot. Erneut einreihen statt „failed“ –
    // sonst pausierte der Autopilot wegen eines Testfehlers, den es nie gab. Ein Merge nach main wurde vom Gate-Pfad
    // schon zurückgenommen.
    if (isShuttingDown()) {
      await pool.query(
        `UPDATE sprints SET git_sync = 'pending', git_message = $2 WHERE id = $1 AND git_sync = 'running'`,
        [sprint.id, 'Durch einen Neustart unterbrochen – die Git-Sicherung läuft nach dem Start erneut.'],
      );
      console.info(`Git-Sicherung für Sprint ${sprint.id} durch Neustart unterbrochen, wird wiederholt.`);
      return 0;
    }
    await pool.query(`UPDATE sprints SET git_sync = 'failed', git_message = $2, git_synced_at = NOW() WHERE id = $1`, [
      sprint.id,
      [...log, message].join(' ').slice(0, 1500),
    ]);
    console.error(`Git-Sicherung für Sprint ${sprint.id} fehlgeschlagen: ${message}`);
    return 0;
  } finally {
    releaseTree();
  }
}

/**
 * Entscheidet über den PR-Modus beim Sprint-Abschluss: nur bei `github_mode = 'issues+pr'`, GitHub-Remote und
 * angemeldeter gh CLI. Sonst null – dann läuft der Abschluss wie bisher (direkter Merge).
 */
async function planPullRequest(
  pool: Pool,
  project: string,
  sprint: PendingSprint,
  cwd: string,
  execute: CommandExecutor,
  log: string[],
): Promise<PullRequestPlan | null> {
  if (sprint.status !== SPRINT_STATUS.completed) return null;
  const settings = (
    await pool
      .query<{ mode: string }>('SELECT github_mode AS mode FROM projects WHERE slug = $1', [project])
      .catch(() => ({ rows: [] as { mode: string }[] }))
  ).rows[0];
  const repo = githubRepo(sprint.remote);
  if (settings?.mode !== 'issues+pr' || !repo) return null;
  const adapter = createGithubAdapter(repo, execute, cwd);
  const auth = await adapter.authStatus();
  if (!auth.ok) {
    log.push(`PR-Modus übersprungen (${auth.message}) – Abschluss wie bisher.`);
    return null;
  }
  const report = (
    await pool.query<{ content: string }>(
      `SELECT content FROM docs WHERE project_slug = $1 AND kind = 'sprint' AND sprint_id = $2
        ORDER BY updated_at DESC LIMIT 1`,
      [project, sprint.id],
    )
  ).rows[0]?.content;
  return {
    adapter,
    body: `${report || `Sprint ${sprint.name}`}\n\n---\n_Automatisch geöffnet vom Mainty Dev Log._`,
    existing: sprint.prUrl ?? null,
  };
}
