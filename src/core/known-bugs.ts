import type { KnownBug } from '../api/bugs.js';
import { containsUntrusted } from '../runner/hoster.js';
import { fenceExternalText, isUntrustedBugSource } from './bug-trust.js';
import { BUG_STATUS } from './status.js';

/**
 * Zeile für „Bekannte Bugs“ im Prompt. Auch freigegebene Bugs aus Betrieb oder GitHub bleiben Fremdtext: Titel,
 * Beschreibung und Lösung stehen dann eingefasst (der Prompt braucht dazu den Sicherheitshinweis, `containsUntrusted`).
 */
export function knownBugLine(bug: KnownBug): string {
  const head = `- [${bug.status === BUG_STATUS.fixed ? 'behoben' : 'offen'} / ${bug.severity}]`;
  const text =
    `${bug.title}${bug.description ? ` – ${bug.description.slice(0, 200)}` : ''}` +
    `${bug.fixNotes ? ` | Lösung: ${bug.fixNotes.slice(0, 300)}` : ''}`;
  const foreign =
    isUntrustedBugSource(bug.source) || containsUntrusted(`${bug.title}\n${bug.description}\n${bug.fixNotes}`);
  return foreign ? `${head}\n${fenceExternalText(text)}` : `${head} ${text}`;
}
