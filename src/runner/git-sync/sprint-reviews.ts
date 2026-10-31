// Sprints im Review (PR-Modus): CI verfolgen, rote Läufe als Bug melden, mergen und taggen.
import { existsSync, realpathSync } from 'node:fs';
import type { Pool } from 'pg';
import { logged } from '../../core/log.js';
import { withProjectLock } from '../../core/project-lock.js';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import type { CiStatus, HosterAdapter } from '../hoster.js';
import {
  checkedOutElsewhere,
  type GitHelpers,
  gitHelpers,
  MAIN_BRANCH,
  sprintBranchOf,
  sprintTag,
} from './git-helpers.js';
import { ciLogExcerpt } from './ci.js';
import { goLiveLogged } from './sprint-sync.js';
import { BUG_STATUS, SPRINT_STATUS } from '../../core/status.js';

interface ReviewSprint {
  id: string;
  name: string;
  branch?: string | null;
  prUrl: string;
  ciStatus: CiStatus | null;
  ciBugRun: string | null;
}

/** Titel der Meldung zu roter CI im Pull Request eines Sprints (beim Anlegen und beim Beerdigen gleich). */
export const ciBugTitle = (sprintName: string): string => `CI rot im Pull Request von „${sprintName}“`.slice(0, 180);

/** Legt für einen roten CI-Lauf genau einen Bug an (der Lauf wird am Sprint vermerkt, bevor der Bug entsteht). */
async function reportCiFailure(
  pool: Pool,
  project: string,
  sprint: ReviewSprint,
  run: string,
  adapter: HosterAdapter,
): Promise<void> {
  const claimed = await pool.query(
    `UPDATE sprints SET ci_bug_run = $2 WHERE id = $1 AND ci_bug_run IS DISTINCT FROM $2 RETURNING id`,
    [sprint.id, run],
  );
  if (!claimed.rows[0]) return;
  const log = await adapter
    .failedRunLog(run)
    .catch((error: unknown) => `Log nicht abrufbar: ${error instanceof Error ? error.message : String(error)}`);
  const excerpt = ciLogExcerpt(log);
  await pool.query(
    `INSERT INTO bugs (project_slug, title, description, severity, source) VALUES ($1, $2, $3, 'high', 'github')`,
    [
      project,
      ciBugTitle(sprint.name),
      [
        `Der CI-Lauf ${run} für den Pull Request ${sprint.prUrl} ist fehlgeschlagen. Der Sprint bleibt im Review und ` +
          `wird nicht gemergt; nach einem grünen Lauf übernimmt Dev Log Merge und Tag.`,
        'Auszug aus `gh run view --log-failed` (gekürzt, Zugangsdaten maskiert):',
        `\`\`\`text\n${excerpt.replace(/```/g, "'''") || '(kein Log)'}\n\`\`\``,
      ].join('\n\n'),
    ],
  );
}

/**
 * Nach dem Merge auf GitHub: main holen, den Sprint-Tag wie bisher setzen und pushen und das lokale main nachziehen –
 * auch im Live-Ordner, wenn main dort ausgecheckt ist und keine offenen Änderungen hat (sonst bleibt es beim Hinweis).
 * Ist `cwd` selbst der Live-Ordner (kein eigener Agent-Ordner), wechselt er vom Sprint-Branch auf main.
 */
export async function tagMergedSprint(
  cwd: string,
  sprint: { id: string; name: string; branch?: string | null },
  rawExecute: CommandExecutor = runCommand,
  /** Projektordner, aus dem live geschaltet wird (projects.repository). */
  liveFolder = cwd,
): Promise<{ commit: string; log: string[]; mainUpdated: boolean }> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  const log: string[] = [];
  let mainUpdated: boolean;
  const remoteMain = `refs/remotes/origin/${MAIN_BRANCH}`;
  await must('fetch', 'origin', `+refs/heads/${MAIN_BRANCH}:${remoteMain}`);
  const tag = sprintTag(sprint.name, sprint.id);
  await must('tag', '-f', tag, remoteMain);
  await must('push', '--force', 'origin', `refs/tags/${tag}`);
  log.push(`Pull Request gemergt, Tag ${tag} gepusht.`);
  const head = (await git('rev-parse', '--abbrev-ref', 'HEAD')).output;
  const elsewhere = head === MAIN_BRANCH ? null : await checkedOutElsewhere(git, MAIN_BRANCH, cwd);
  if (elsewhere) {
    // Agents arbeiten im eigenen Ordner, main ist im Live-Ordner ausgecheckt (der Normalfall): dort nachziehen, sonst
    // ginge im PR-Modus nie ein Sprint live. Nur Fast-Forward und nur ohne offene Änderungen – wie beim direkten Merge.
    const live = gitHelpers(execute, elsewhere).git;
    const branch = (await live('rev-parse', '--abbrev-ref', 'HEAD')).output.trim();
    const status = await live('status', '--porcelain', '--untracked-files=no');
    const clean = branch === MAIN_BRANCH && status.exitCode === 0 && !status.output.trim();
    const updated = clean ? await live('merge', '--ff-only', remoteMain) : null;
    mainUpdated = updated?.exitCode === 0;
    log.push(
      mainUpdated
        ? `${MAIN_BRANCH} in ${elsewhere} nachgezogen.`
        : `${MAIN_BRANCH} ist in ${elsewhere} ausgecheckt${clean ? ' und weicht ab' : ' und hat offene Änderungen'} – dort mit „git pull“ übernehmen.`,
    );
  } else {
    // Nur Fast-Forward: lokale Commits auf main gehen nie verloren.
    const updated =
      head === MAIN_BRANCH
        ? await git('merge', '--ff-only', remoteMain)
        : await git('fetch', 'origin', `${MAIN_BRANCH}:${MAIN_BRANCH}`);
    mainUpdated = updated.exitCode === 0;
    log.push(
      mainUpdated
        ? `Lokales ${MAIN_BRANCH} aktualisiert.`
        : `Lokales ${MAIN_BRANCH} weicht ab – bitte mit „git pull“ übernehmen.`,
    );
    // Ohne eigenen Agent-Ordner ist dieser Ordner der Live-Ordner und steht noch auf dem Sprint-Branch: die Referenz
    // allein bringt nichts live. Auf main wechseln – nur vom Branch dieses Sprints und ohne offene Änderungen.
    if (mainUpdated && head !== MAIN_BRANCH && sameFolder(cwd, liveFolder)) {
      mainUpdated = await switchLiveFolderToMain(git, head, sprintBranchOf(sprint), log);
    }
  }
  return { commit: await must('rev-parse', '--short', remoteMain), log, mainUpdated };
}

const sameFolder = (a: string, b: string): boolean =>
  (existsSync(a) ? realpathSync(a) : a) === (existsSync(b) ? realpathSync(b) : b);

/** Live-Ordner vom gemergten Sprint-Branch auf main bringen; ein fremder Branch oder offene Änderungen bleiben. */
async function switchLiveFolderToMain(
  git: GitHelpers['git'],
  head: string,
  branch: string,
  log: string[],
): Promise<boolean> {
  if (head !== branch) {
    log.push(
      `Projektordner steht auf ${head} statt auf ${branch} – nicht live geschaltet, dort „git switch ${MAIN_BRANCH}“.`,
    );
    return false;
  }
  const status = await git('status', '--porcelain', '--untracked-files=no');
  if (status.exitCode !== 0 || status.output.trim()) {
    log.push(
      `Projektordner hat offene Änderungen auf ${branch} – nicht live geschaltet, dort aufräumen und „git switch ${MAIN_BRANCH}“.`,
    );
    return false;
  }
  const switched = await git('checkout', MAIN_BRANCH);
  log.push(
    switched.exitCode === 0
      ? `Projektordner von ${branch} auf ${MAIN_BRANCH} gewechselt.`
      : `Projektordner bleibt auf ${branch}: ${switched.output.trim().slice(-200)}`,
  );
  return switched.exitCode === 0;
}

/**
 * Verfolgt Sprints im Review (PR-Modus): CI-Status speichern, bei roter CI einen Bug je Lauf anlegen, bei grüner CI
 * (und, falls gefordert, nach Approve) mergen und taggen. Wurde der Pull Request von Hand gemergt, wird nur getaggt.
 * Gibt die Zahl der abgeschlossenen Sprints zurück.
 */
export async function pollSprintReviews(
  pool: Pool,
  project: string,
  cwd: string,
  adapter: HosterAdapter,
  requireApproval: boolean,
  rawExecute: CommandExecutor = runCommand,
  /** Nach dem Merge des Pull Requests „Live schalten“ wie beim direkten Merge (goLive). */
  onMergedMain?: () => Promise<boolean | null | void>,
): Promise<number> {
  const sprints = (
    await pool.query<ReviewSprint>(
      `SELECT id, name, branch, pr_url AS "prUrl", ci_status AS "ciStatus", ci_bug_run AS "ciBugRun" FROM sprints
        WHERE project_slug = $1 AND status = '${SPRINT_STATUS.review}' AND pr_url IS NOT NULL ORDER BY updated_at`,
      [project],
    )
  ).rows;
  let finished = 0;
  for (const sprint of sprints) {
    const pr = await adapter.pullRequestState(sprint.prUrl);
    if (pr.state === 'closed') {
      await pool.query(
        `UPDATE sprints SET status = '${SPRINT_STATUS.completed}', git_sync = 'failed', git_message = $2, git_synced_at = NOW()
          WHERE id = $1 AND status = '${SPRINT_STATUS.review}'`,
        [
          sprint.id,
          `Pull Request ${sprint.prUrl} wurde ohne Merge geschlossen – ${MAIN_BRANCH} bleibt unverändert. ` +
            'Sprint-Branch manuell übernehmen oder die Git-Sicherung erneut starten.',
        ],
      );
      continue;
    }
    let ciStatus = sprint.ciStatus;
    if (pr.state === 'open') {
      const checks = await adapter.pullRequestChecks(sprint.prUrl);
      ciStatus = checks.status;
      if (checks.status !== sprint.ciStatus) {
        await pool.query(`UPDATE sprints SET ci_status = $2 WHERE id = $1`, [sprint.id, checks.status]);
      }
      if (checks.status === 'failure') {
        if (checks.failedRun && checks.failedRun !== sprint.ciBugRun) {
          await reportCiFailure(pool, project, sprint, checks.failedRun, adapter);
        }
        continue;
      }
      if (checks.status === 'pending') continue;
      if (requireApproval && !pr.approved) {
        await pool.query(`UPDATE sprints SET git_message = $2 WHERE id = $1`, [
          sprint.id,
          `CI grün – wartet auf Freigabe (Approve) im Pull Request ${sprint.prUrl}.`,
        ]);
        continue;
      }
      await adapter.mergePullRequest(sprint.prUrl);
    }
    const live =
      (await pool.query<{ repository: string }>('SELECT repository FROM projects WHERE slug = $1', [project])).rows[0]
        ?.repository ?? cwd;
    const tagged = await tagMergedSprint(cwd, sprint, rawExecute, live);
    // Nur mit nachgezogenem lokalem main: sonst würde der alte Stand deployt.
    if (tagged.mainUpdated && onMergedMain) await goLiveLogged(onMergedMain, tagged.log);
    // Die CI-Meldung zu diesem Pull Request ist mit dem Merge erledigt (auch wenn ein Wiederholungslauf grün war).
    await pool
      .query(
        `UPDATE bugs SET status = '${BUG_STATUS.fixed}', fixed_at = NOW(), updated_at = NOW()
          WHERE project_slug = $1 AND source = 'github' AND title = $2 AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}')`,
        [project, ciBugTitle(sprint.name)],
      )
      .catch(logged('sprint-reviews'));
    await pool.query(
      `UPDATE sprints SET status = '${SPRINT_STATUS.completed}', ci_status = $5, git_sync = 'done', git_message = $2, git_commit = $3,
              git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
      [sprint.id, tagged.log.join(' '), tagged.commit, MAIN_BRANCH, ciStatus],
    );
    finished += 1;
  }
  return finished;
}
