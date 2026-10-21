// Visuelle Prüfung: optionales KI-Urteil eines Bild-Modells über die Akzeptanzkriterien anhand der Screenshots.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandExecutor } from '../core/command.js';
import { executeAgentCommand } from '../agent/claude-stream.js';
import { DEFAULT_OLLAMA_URL } from '../agent/ollama-client.js';
import { type CheckResult, parseChecks } from './acceptance.js';
import { agentEnvironment, buildInvocation } from './runner-prompts.js';
import type { VisualFinding } from './visual-findings.js';
import type { VisualSettings } from './visual-settings.js';

const MAX_JUDGE_IMAGES = 6;
const VISUAL_DIRECTORY = join('.dev-log', 'visual');

// ---------------------------------------------------------------------------------------------------------------
// KI-Urteil (optional)

export function buildJudgePrompt(criteria: string[], images: { path: string; label: string }[]): string {
  return [
    'Du bist der visuelle Tester im AIdeation. Beurteile anhand der Screenshots, ob die Akzeptanzkriterien sichtbar erfüllt sind. Ändere keine Dateien.',
    `## Screenshots\n${images.map((image) => `- ${image.label}: ${image.path}`).join('\n')}`,
    `## Akzeptanzkriterien\n${criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}`,
    'Antworte knapp. Schliesse mit genau einer Zeile je Kriterium ab:\n@@CHECK {"nr":1,"met":true,"manual":false,"note":"kurze Begründung"}\nSetze "manual":true, wenn sich das Kriterium auf Screenshots nicht beurteilen lässt (z. B. Verhalten im Hintergrund).',
  ].join('\n\n');
}

/** Ein Befund je Akzeptanzkriterium; fehlt das Urteil, bleibt der Punkt für den Menschen offen. */
export function judgeFindings(output: string, criteria: string[]): VisualFinding[] {
  const results = parseChecks(output);
  return criteria.map((criterion, index) => {
    const result: CheckResult | undefined = results.find((entry) => entry.nr === index + 1);
    return {
      check: 'ai' as const,
      text: `KI-Urteil: ${criterion}`.slice(0, 500),
      met: result?.met ?? false,
      manual: result ? result.manual : true,
      note: result ? result.note : 'Kein Urteil des Bild-Modells',
    };
  });
}

export interface JudgeOptions {
  criteria: string[];
  shots: { label: string; png: Buffer }[];
  cwd: string;
  itemId: string;
  settings: VisualSettings;
  command?: string[] | null;
  execute?: CommandExecutor;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Fragt die Claude-CLI des Agents (Bilder als Dateien im Projektordner) oder ein Ollama-Bildmodell. */
export async function judgeScreenshots(options: JudgeOptions): Promise<string> {
  const shots = options.shots.slice(0, MAX_JUDGE_IMAGES);
  if (options.command?.length && options.execute) {
    const directory = join(options.cwd, VISUAL_DIRECTORY, options.itemId);
    await mkdir(directory, { recursive: true });
    try {
      const images: { path: string; label: string }[] = [];
      for (const [index, shot] of shots.entries()) {
        const path = join(VISUAL_DIRECTORY, options.itemId, `${index + 1}.png`);
        await writeFile(join(options.cwd, path), shot.png);
        images.push({ path, label: shot.label });
      }
      const result = await executeAgentCommand(
        options.execute,
        buildInvocation(options.command, buildJudgePrompt(options.criteria, images)),
        options.cwd,
        { timeoutMs: options.timeoutMs, env: agentEnvironment(options.cwd) },
      );
      return result.exitCode === 0 ? result.output : '';
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!options.settings.visionModel) return '';
  const baseUrl = (process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model: options.settings.visionModel,
      stream: false,
      messages: [
        {
          role: 'user',
          content: buildJudgePrompt(
            options.criteria,
            shots.map((shot, index) => ({ path: `Bild ${index + 1}`, label: shot.label })),
          ),
          images: shots.map((shot) => shot.png.toString('base64')),
        },
      ],
    }),
  });
  if (!response.ok) return '';
  const data = (await response.json()) as { message?: { content?: unknown } };
  return typeof data.message?.content === 'string' ? data.message.content : '';
}
