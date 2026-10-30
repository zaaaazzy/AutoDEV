// Vorschau-Aufnahme des visuellen Testers im Sandbox-Container: Playwright und Chromium kommen aus dem Image
// aideation-agent (visual-capture-cli.ts), nicht vom Host. Der Worker übergibt den Auftrag, liest Screenshots und
// Befunde aus einem Wegwerf-Ordner und räumt ihn danach weg.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandExecutor } from '../core/command.js';
import { runInSandbox } from '../core/sandbox.js';
import type { CaptureFn, CapturedPage, CaptureOptions, PageCapture } from './visual-capture.js';
import type { Credentials, Device, VisualSettings } from './visual-settings.js';
import { defined } from '../core/defined.js';

export const CAPTURE_SCRIPT = '/opt/aideation/visual-capture.mjs';
const CAPTURE_JOB = 'AIDEATION_CAPTURE_JOB';
const CAPTURE_TIMEOUT_MS = 5 * 60_000;

export interface CaptureJob {
  baseUrl: string;
  pages: string[];
  settings: VisualSettings;
  credentials: Credentials | null;
}

export interface CaptureResultFile {
  pages: { page: string; device: Device; capture: Omit<PageCapture, 'png'> & { png: string | null } }[];
}

/**
 * Vom Container aus gesehen: localhost bzw. 127.0.0.1 des Hosts heisst dort host.docker.internal. Andere Adressen
 * (Review-Server im LAN, öffentliche Vorschau) bleiben, wie sie sind.
 */
export function containerPreviewUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(parsed.hostname)) {
      parsed.hostname = 'host.docker.internal';
      return parsed.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * CaptureFn im Container. Der Container bindet keinen Worktree ein (es läuft nur das AIdeation-Skript aus dem Image)
 * und hängt am Bridge-Netzwerk, damit er die Vorschau auf dem Host bzw. im LAN erreicht. Zugangsdaten des Test-Logins
 * gehen nur über die Umgebung des Docker-Clients (-e NAME), nie als Argument.
 */
export function captureInSandbox(sandbox: {
  runId: string;
  project: string;
  docker?: CommandExecutor;
  environment?: NodeJS.ProcessEnv;
}): CaptureFn {
  return async (options: CaptureOptions): Promise<CapturedPage[]> => {
    const out = await mkdtemp(join(tmpdir(), 'aideation-capture-'));
    try {
      const job: CaptureJob = {
        baseUrl: containerPreviewUrl(options.baseUrl),
        pages: options.pages,
        settings: options.settings,
        credentials: options.credentials,
      };
      options.onProgress?.('Vorschau-Aufnahme im Sandbox-Container (Playwright aus dem Image)');
      const result = await runInSandbox(['node', CAPTURE_SCRIPT], out, {
        runId: sandbox.runId,
        project: sandbox.project,
        docker: sandbox.docker,
        workspace: false,
        outputDir: out,
        network: 'bridge',
        passEnv: [CAPTURE_JOB],
        environment: { ...(sandbox.environment ?? process.env), [CAPTURE_JOB]: JSON.stringify(job) },
        signal: options.signal,
        timeoutMs: CAPTURE_TIMEOUT_MS,
        onChunk: (chunk) => {
          for (const line of chunk.split('\n')) {
            const progress = /^Fortschritt: (.+)$/.exec(line.trim());
            if (progress) options.onProgress?.(defined(progress[1]));
          }
        },
      });
      const file = await readFile(join(out, 'result.json'), 'utf8').catch(() => null);
      if (!file) {
        throw new Error(
          `Aufnahme im Container fehlgeschlagen (Exit-Code ${result.exitCode}): ${result.output.trim().slice(-400)}`,
        );
      }
      const parsed = JSON.parse(file) as CaptureResultFile;
      const pages: CapturedPage[] = [];
      for (const entry of parsed.pages) {
        // Nur Dateinamen aus dem eigenen Ordner, kein Pfad aus dem Container.
        const name = entry.capture.png && /^\d+\.png$/.test(entry.capture.png) ? entry.capture.png : null;
        const png = name ? await readFile(join(out, name)).catch(() => null) : null;
        pages.push({ page: entry.page, device: entry.device, capture: { ...entry.capture, png } });
      }
      return pages;
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };
}
