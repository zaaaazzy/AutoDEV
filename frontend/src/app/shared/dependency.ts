import { DEVELOPMENT_STATUS, type DevelopmentItem } from '../core/models.js';

/** Aufträge, die noch starten können und darum auf ihre Abhängigkeit warten. */
const WAITING_STATUSES = new Set<string>([DEVELOPMENT_STATUS.backlog, DEVELOPMENT_STATUS.planned]);

/**
 * Wartet der Auftrag auf seine Abhängigkeit („Hängt ab von“)? Nur offene Aufträge warten; der Status des anderen
 * Auftrags kommt aus der geladenen Liste, sonst aus den Spalten des Servers.
 */
export function waitsForDependency(
  item: Pick<DevelopmentItem, 'dependsOn' | 'dependsOnStatus' | 'status'>,
  dependency: Pick<DevelopmentItem, 'status'> | null | undefined,
): boolean {
  if (!item.dependsOn || !WAITING_STATUSES.has(item.status)) return false;
  const status = dependency?.status ?? item.dependsOnStatus ?? null;
  return status !== DEVELOPMENT_STATUS.done;
}
