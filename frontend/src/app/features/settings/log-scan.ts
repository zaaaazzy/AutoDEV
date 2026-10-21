import type { ProductionStatus } from '../../core/models.js';
import { formatDateTime } from '../../shared/format.js';

/** Zustand des Log-Scans für die Einstellungen „Betrieb“; null, wenn für das Projekt keine Dienste gesetzt sind. */
export function logScanSummary(
  status: ProductionStatus | null,
): { label: string; value: string; problem: boolean }[] | null {
  if (!status?.logsConfigured) return null;
  const rows = [
    {
      label: 'Letzter Scan',
      value: status.logsScannedAt ? formatDateTime(status.logsScannedAt) : 'Noch kein Scan',
      problem: false,
    },
    { label: 'Letzter Fehler', value: status.logError ?? 'Keiner', problem: Boolean(status.logError) },
    {
      label: 'Erfasste Ereignisse',
      value: `${status.logEvents ?? 0} (${status.logOccurrences ?? 0} Vorkommen)`,
      problem: false,
    },
  ];
  if (status.logGap) rows.push({ label: 'Lücke', value: status.logGap, problem: true });
  return rows;
}
