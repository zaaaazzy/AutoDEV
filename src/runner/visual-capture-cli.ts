// Vorschau-Aufnahme im Sandbox-Container (Playwright aus dem Image aideation-agent statt vom Host). Gebündelt nach
// /opt/aideation/visual-capture.mjs; gestartet von captureInSandbox (visual-sandbox.ts). Der Auftrag kommt als JSON in
// AIDEATION_CAPTURE_JOB (nur als Name an docker übergeben), die Ergebnisse gehen nach /out (result.json, n.png).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureWithPlaywright } from './visual-capture.js';
import type { CaptureJob, CaptureResultFile } from './visual-sandbox.js';

async function main(): Promise<void> {
  const job = JSON.parse(process.env.AIDEATION_CAPTURE_JOB ?? '{}') as CaptureJob;
  const out = process.env.AIDEATION_CAPTURE_OUT ?? '/out';
  const captured = await captureWithPlaywright({
    baseUrl: job.baseUrl,
    pages: job.pages,
    settings: job.settings,
    credentials: job.credentials,
    // Abbruch und Zeitlimit beenden den ganzen Container (docker kill).
    signal: new AbortController().signal,
    onProgress: (message) => console.info(`Fortschritt: ${message}`),
  });
  const result: CaptureResultFile = { pages: [] };
  for (const [index, entry] of captured.entries()) {
    const { png, ...capture } = entry.capture;
    const file = png ? `${index + 1}.png` : null;
    if (png && file) await writeFile(join(out, file), png);
    result.pages.push({ page: entry.page, device: entry.device, capture: { ...capture, png: file } });
  }
  await writeFile(join(out, 'result.json'), JSON.stringify(result));
  console.info(`Aufnahme fertig: ${result.pages.length} Seite(n).`);
}

main().catch((error: unknown) => {
  console.error(`Aufnahme fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
