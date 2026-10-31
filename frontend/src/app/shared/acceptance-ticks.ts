import { signal } from '@angular/core';
import type { AcceptanceCheck } from '../core/models.js';

/** Das Häkchen im DOM; der Klick hat `checked` schon umgeschaltet, bevor `change` feuert. */
export interface TickBox {
  checked: boolean;
}

/**
 * Häkchen der offenen Abnahmepunkte („Aktionen“, Auftragsdetail). `[checked]` hängt an `saving()`: Der Punkt bleibt
 * während des Speicherns gesetzt und springt nach einem Fehler (403, 409, Netz) zurück. Bei Erfolg verschwindet er
 * nach dem Nachladen aus der Liste der offenen Punkte.
 */
export class AcceptanceTicks {
  private readonly pending = signal<ReadonlySet<string>>(new Set());

  saving(itemId: string, check: AcceptanceCheck): boolean {
    return this.pending().has(tickKey(itemId, check));
  }

  async tick(box: TickBox, itemId: string, check: AcceptanceCheck, save: () => Promise<boolean>): Promise<void> {
    const key = tickKey(itemId, check);
    // Zweiter Klick während des Speicherns: nichts senden, Häkchen bleibt wie es ist.
    if (this.pending().has(key)) {
      box.checked = true;
      return;
    }
    this.pending.update((keys) => new Set(keys).add(key));
    let saved = false;
    try {
      saved = await save();
    } finally {
      this.pending.update((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
      // Auch direkt im DOM: Hat die Änderungserkennung `true` nie gesehen, setzt sie das Häkchen nicht zurück.
      if (!saved) box.checked = false;
    }
  }
}

function tickKey(itemId: string, check: AcceptanceCheck): string {
  return `${itemId}:${check.kind}:${check.position}`;
}
