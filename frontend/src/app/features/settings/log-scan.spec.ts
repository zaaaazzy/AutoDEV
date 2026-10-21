import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProductionStatus } from '../../core/models.js';
import { formatDateTime } from '../../shared/format.js';
import { logScanSummary } from './log-scan.js';

const status = (fields: Partial<ProductionStatus>): ProductionStatus => ({
  healthUrl: null,
  configured: true,
  healthy: true,
  down: false,
  failures: 0,
  lastError: null,
  checkedAt: null,
  downSince: null,
  logsConfigured: true,
  logsScannedAt: null,
  logError: null,
  logGap: null,
  logEvents: 0,
  logOccurrences: 0,
  openBugs: 0,
  criticalBugs: 0,
  last24h: 0,
  ...fields,
});

test('Log-Scan in den Einstellungen: Zeitpunkt, letzter Fehler, Ereignisse und Lücke', () => {
  const rows = logScanSummary(
    status({
      logsScannedAt: '2026-10-18T10:00:00Z',
      logError: 'no such service: api',
      logGap: 'Logs von … nicht gelesen',
      logEvents: 2,
      logOccurrences: 13,
    }),
  )!;
  assert.deepEqual(
    rows.map((row) => [row.label, row.value, row.problem]),
    [
      ['Letzter Scan', formatDateTime('2026-10-18T10:00:00Z'), false],
      ['Letzter Fehler', 'no such service: api', true],
      ['Erfasste Ereignisse', '2 (13 Vorkommen)', false],
      ['Lücke', 'Logs von … nicht gelesen', true],
    ],
  );
});

test('Log-Scan: neutrale Texte vor dem ersten Scan, nichts ohne Log-Dienste', () => {
  assert.deepEqual(
    logScanSummary(status({}))!.map((row) => row.value),
    ['Noch kein Scan', 'Keiner', '0 (0 Vorkommen)'],
  );
  assert.equal(logScanSummary(status({ logsConfigured: false })), null);
  assert.equal(logScanSummary(null), null);
});
