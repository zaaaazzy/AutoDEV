# Agenten per Drag & Drop zwischen Phasen verschieben

Auftrag ab7ebbab (Sprint 23).

## Ergebnis

Im Workflow-Panel (Agents → Workflow) lassen sich Schritte am Griff ⠿ ziehen: innerhalb einer Phase an eine neue Position und in eine andere Phase (Sprintstart, vor dem Auftrag, während, nach dem Auftrag, abgelehnt, abgeschlossen). Die Änderung wird gespeichert und bleibt nach dem Neuladen erhalten.

## Umsetzung

- **Technik:** Natives HTML5-Drag-and-Drop (Desktop). Auf Touch-Geräten funktioniert es nicht, dort bleiben die Buttons.
- **Berechnung** (`frontend/src/app/features/agents/workflow-order.ts`): `moveStep()` liefert die neuen Reihenfolgen. Bei einem Phasenwechsel zuerst die Zielphase mit dem Schritt, danach die Quellphase ohne ihn (lückenlos ab 1). Innerhalb einer Phase gibt es einen Aufruf; Ablegen an der eigenen Stelle ergibt eine leere Liste und sendet nichts. `applyOrders()` zeigt das Ergebnis sofort an, bis der Server-Stand geladen ist.
- **Komponente** (`workflow-steps.component.ts`): Zustand `dragged` und `dropTarget` (Phase und Einfügestelle). Die Einfügestelle ergibt sich aus der Mitte der Schritte relativ zum Mauszeiger. Gespeichert wird mit `POST /projects/:slug/workflow/order`, je Phase ein Aufruf nacheinander. Danach, auch bei einem Fehler, wird der Workflow neu geladen (Anzeige springt auf den Server-Stand zurück; der Fehler erscheint als Meldung).
- **Tastatur/Barrierefreiheit:** ↑/↓ unverändert. Neu: Auswahlfeld „In Phase verschieben“ je Schritt (setzt den Schritt ans Ende der Zielphase).
- **Rechte und Sperre:** Griffe, Auswahlfeld und Drop sind nur mit `auth.can('agents')` aktiv (Griffe sonst ausgeblendet). Während einer Speicherung (`store.busy()`) sind Ziehen, ↑/↓ und Auswahl deaktiviert.
- **Optik** (`frontend/src/styles/14-agents.css`): Der gezogene Eintrag ist leicht transparent mit weichem Schatten, die Zielstelle zeigt eine Einfügemarke (`drop-before`/`drop-after`, bei leerer Phase `drop-here`), die Phase unter dem Zeiger ist hervorgehoben (`drop-active`). Es werden nur Farben des bestehenden Phasenschemas genutzt.
- **Backend:** unverändert. `POST /projects/:slug/workflow/order` setzt `phase` und `position` bereits; `enabled` wird nicht angefasst, ein pausierter Schritt bleibt also pausiert.
- **Offener Prüfpunkt geklärt:** `agents.phase`/`agents.position` werden im Runner (`loadWorkflow`, `src/runner/runner-selection.ts`) nur noch für ältere Projekte ganz ohne Workflow-Schritte gelesen. Sobald Schritte existieren, zählt `workflow_steps`. Das Verschieben muss die Agent-Spalten deshalb nicht nachziehen.

## Tests

- `frontend/src/app/features/agents/workflow-order.spec.ts`: Ziehen nach unten/oben, Ablegen an eigener Stelle, Phasenwechsel (Zielphase zuerst, dann Quelle), leere Phase und zu große Einfügestelle, lückenlose Nummerierung mit unverändertem Status.
- `src/api/app.test.ts`: ein Aufruf je Phase, `SET position = o.ord, phase = $2`, `enabled` unberührt, ungültige Phase → 400.
- `e2e/full-ui.check.ts`: Ziehen in eine andere Phase mit Schatten und Einfügemarke, Erscheinen nach dem Neuladen; die ↑/↓-Prüfung bleibt.
- Die Dokumentation hat die Tests nicht erneut ausgeführt.

## Geänderte Dateien (für diesen Auftrag)

- `frontend/src/app/features/agents/workflow-steps.component.ts`
- `frontend/src/app/features/agents/workflow-order.ts` (neu)
- `frontend/src/app/features/agents/workflow-order.spec.ts` (neu)
- `frontend/src/styles/14-agents.css`
- `src/api/app.test.ts`
- `e2e/full-ui.check.ts`
- `docs/benutzerhandbuch-workflow-umbau-waehrend-lauf.md`, `docs/workflows.md`

Die weiteren Dateien in der Liste des Entwicklers stammen aus Merges anderer Sprint-23-Aufträge.

## Worauf zu achten ist

- Ein Verschieben wirkt erst im nächsten Lauf; ein laufender Auftrag nutzt den Ablauf vom Start (siehe Benutzerhandbuch „Workflow umbauen während eines Laufs“).
- Die Quellphase wird nur neu nummeriert, weil der Client sie mitsendet. Zwei Aufrufe laufen nacheinander, nicht in einer Transaktion; bricht der zweite ab, korrigiert das Neuladen die Anzeige, die Quellphase kann aber eine Lücke in den Positionen behalten (die Sortierung bleibt davon unberührt).
- Wer Bedienelemente im Workflow-Panel umbenennt, muss `e2e/full-ui.check.ts` im selben Auftrag anpassen (Namen und Rollen der ↑/↓-Buttons beibehalten).
