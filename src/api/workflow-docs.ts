import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeneratedDoc } from './generated-docs.js';

/**
 * Register „Workflow“ in der Dokumentation: wie AIdeation selbst arbeitet. Die Inhalte kommen aus den Markdown-Dateien
 * im docs-Ordner der Installation (im Container /app/docs), damit Doku im Repository und Anzeige gleich bleiben.
 */
export const WORKFLOW_DOCS: readonly { file: string; title: string }[] = [
  { file: 'laufzeit.md', title: 'Ablauf zur Laufzeit' },
  { file: 'workflows.md', title: 'Workflows' },
  { file: 'agents-und-rechte.md', title: 'Agents und Rechte' },
];

const MAX_CHARS = 200_000;
const cache = new Map<string, { mtimeMs: number; content: string }>();

export function workflowDocsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DEV_LOG_DOCS_DIR?.trim() || join(process.cwd(), 'docs');
}

async function readCached(path: string): Promise<{ content: string; updated: Date } | null> {
  try {
    const info = await stat(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === info.mtimeMs) return { content: hit.content, updated: info.mtime };
    const content = (await readFile(path, 'utf8')).slice(0, MAX_CHARS);
    cache.set(path, { mtimeMs: info.mtimeMs, content });
    return { content, updated: info.mtime };
  } catch {
    return null;
  }
}

/** Die Workflow-Dokumente für ein Projekt (gleich für alle Projekte); fehlende Dateien werden ausgelassen. */
export async function workflowDocs(slug: string, directory = workflowDocsDirectory()): Promise<GeneratedDoc[]> {
  const docs = await Promise.all(
    WORKFLOW_DOCS.map(async ({ file, title }): Promise<GeneratedDoc | null> => {
      const found = await readCached(join(directory, file));
      if (!found) return null;
      const at = found.updated.toISOString();
      return {
        id: `workflow-${file.replace(/\.md$/, '')}`,
        projectSlug: slug,
        kind: 'workflow',
        title,
        content: found.content,
        developmentId: null,
        sprintId: null,
        createdAt: at,
        updatedAt: at,
      };
    }),
  );
  return docs.filter((doc): doc is GeneratedDoc => doc !== null);
}
