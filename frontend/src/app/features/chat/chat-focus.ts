import type { ChatZoom } from './chat.component.js';

/** Was die Prüfungen vom DOM brauchen – im Test ohne Browser nachbaubar. */
export interface FocusNode {
  readonly nodeName: string;
  contains(other: FocusNode | null): boolean;
}

/** Fokussierbare Elemente, in der Reihenfolge der Tab-Taste (ohne tabindex > 0). */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Escape gehört dem Chat nur, wenn er vergrössert ist, niemand die Taste schon behandelt hat und der Fokus im Chat
 * liegt – im Modal auch, wenn der Fokus „nirgends“ (body) steht. Escape in fremden Dialogen dockt also nicht ab.
 */
export function handlesEscape(
  event: { defaultPrevented: boolean; target: FocusNode | null },
  panel: FocusNode | null,
  zoom: ChatZoom,
): boolean {
  if (!zoom || event.defaultPrevented || !panel) return false;
  if (panel.contains(event.target)) return true;
  return zoom === 'modal' && (!event.target || ['BODY', 'HTML'].includes(event.target.nodeName));
}

/** Fokusfalle im Modal: Ziel für Tab bzw. Shift+Tab am Rand (oder von ausserhalb), sonst null = Browser macht weiter. */
export function trapFocusTarget<T>(focusables: readonly T[], active: T | null, backwards: boolean): T | null {
  const first = focusables[0];
  const last = focusables.at(-1);
  if (first === undefined || last === undefined) return null;
  const inside = active !== null && focusables.includes(active);
  if (backwards) return !inside || active === first ? last : null;
  return !inside || active === last ? first : null;
}
