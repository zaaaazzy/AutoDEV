import type { ConfirmOptions } from '../../core/confirm.service.js';

/** Lange Listen sprengen den Dialog: die ersten zehn Titel, der Rest als Anzahl. */
const APPROVE_TITLES_MAX = 10;

const umsetzungen = (count: number): string => `${count} ${count === 1 ? 'Umsetzung' : 'Umsetzungen'}`;

/** Rückfrage vor „Alle abnehmen“: Anzahl im Titel, darunter die Titel. */
export function approveAllDialog(items: readonly { title: string }[]): ConfirmOptions {
  const titles = items.map((item) => `„${item.title}“`);
  const rest = titles.length - APPROVE_TITLES_MAX;
  return {
    title: `${umsetzungen(items.length)} abnehmen?`,
    message: 'Alle werden freigegeben; der Worker mergt sie nacheinander in den Sprint-Branch.',
    details: rest > 0 ? [...titles.slice(0, APPROVE_TITLES_MAX), `… und ${rest} weitere`] : titles,
    confirmLabel: 'Alle abnehmen',
    withoutComment: true,
  };
}

/**
 * Ablauf von „Alle abnehmen“: erst die Rückfrage (`ask`, mit Git-Warnung), nur nach Bestätigung genau eine Anfrage
 * (`send`) mit den Zusatzfeldern der Rückfrage (z. B. Begründung trotz Git-Befund). false = abgebrochen.
 */
export async function approveAllFlow(
  items: readonly { title: string }[],
  ask: (options: ConfirmOptions) => Promise<{ body: Record<string, unknown> } | null>,
  send: (body: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  if (!items.length) return false;
  const answer = await ask(approveAllDialog(items));
  if (!answer) return false;
  await send(answer.body);
  return true;
}

/** Erfolgsmeldung mit der Anzahl, die der Server tatsächlich abgenommen hat. */
export function approvedMessage(approved: number, shown: number): string {
  if (!approved) return 'Keine Umsetzung wartete mehr auf die Freigabe – nichts abgenommen.';
  const skipped = shown - approved;
  const note = skipped > 0 ? ` ${umsetzungen(skipped)} stand${skipped === 1 ? '' : 'en'} nicht mehr in Freigabe.` : '';
  return `${umsetzungen(approved)} abgenommen – ${approved === 1 ? 'wird' : 'werden'} gleich gemergt.${note}`;
}
