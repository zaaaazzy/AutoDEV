/**
 * Schmale Schnittstelle zum Git-Hoster (heute nur GitHub über die gh CLI). Ein weiterer Adapter (GitLab, Gitea)
 * implementiert dieselben Methoden; Import, Rückmeldung und PR-Modus kennen nur dieses Interface.
 */

export interface HosterIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export type CiStatus = 'pending' | 'success' | 'failure';

export interface PullRequestChecks {
  status: CiStatus;
  /** Kennung des fehlgeschlagenen CI-Laufs (für den Log-Auszug), sonst null. */
  failedRun: string | null;
}

export interface PullRequestState {
  state: 'open' | 'merged' | 'closed';
  /** Ein Mensch hat den Pull Request freigegeben (Approve). */
  approved: boolean;
}

export interface HosterAdapter {
  /** Prüft die Anmeldung des Worker-Benutzers beim Hoster. */
  authStatus(): Promise<{ ok: boolean; message: string }>;
  /** Offene Issues mit dem Label, optional nur die seit `since` geänderten. */
  listIssues(label: string, since: Date | null): Promise<HosterIssue[]>;
  commentIssue(number: number, body: string): Promise<void>;
  closeIssue(number: number): Promise<void>;
  /** Offener Pull Request des Branches (URL) oder null. */
  findPullRequest(head: string): Promise<string | null>;
  /** Legt den Pull Request an und gibt seine URL zurück. */
  createPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<string>;
  pullRequestChecks(url: string): Promise<PullRequestChecks>;
  pullRequestState(url: string): Promise<PullRequestState>;
  mergePullRequest(url: string): Promise<void>;
  /** Ausgabe der fehlgeschlagenen Schritte eines CI-Laufs (bereits maskiert). */
  failedRunLog(run: string): Promise<string>;
}

/** Fehler des Hosters; `rateLimited` heißt: bis zum nächsten Intervall pausieren. */
export class HosterError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = 'HosterError';
  }
}

// Fremdtext-Marker und Sicherheitshinweis liegen in core/bug-trust.ts (auch Prompts ohne Hoster brauchen sie).
export { containsUntrusted, UNTRUSTED_END, UNTRUSTED_HINT, UNTRUSTED_START } from '../core/bug-trust.js';
