import type { GitProblem, GuardedAction } from './models.js';

/** Was die Aktion betrifft: Live schalten den Projektordner, Freigeben und Sprint starten den Ordner der Agents. */
export function problemsForAction(
  problems: GitProblem[],
  separate: boolean,
  action: GuardedAction | 'all',
): GitProblem[] {
  if (action === 'all') return problems;
  return problems.filter((problem) => {
    if (action === 'go_live') return problem.role === 'live';
    if (problem.code.startsWith('main_')) return false;
    return separate ? problem.role === 'agents' : problem.role === 'live';
  });
}
