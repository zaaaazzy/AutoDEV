# Benutzerhandbuch: Alle Umsetzungen mit einem Klick abnehmen

Stand: 2026-10-31 · Auftrag `fddd9163` · Entwicklerdoku: `docs/auftraege/alle-abnehmen-2026-10-31.md`

## Was sich für dich ändert

Warten mehrere Umsetzungen auf deine Freigabe, musst du sie nicht mehr einzeln mit „✓ Freigeben“ abnehmen.

- Auf der Seite „Aktionen“ steht im Kopf von „Rückmeldungen der Agents“ der Knopf **„✓ Alle abnehmen (n)“**. Er nimmt
  alle angezeigten Umsetzungen in Freigabe ab, die noch nicht abgenommen sind.
- Im Sprintmenü (rechts unter dem Git-Baum) steht derselbe Knopf. Er nimmt nur die Umsetzungen dieses Sprints ab.
- Unter jedem Sprint gibt es jetzt zwei Reiter: **„Aufträge“** (wie bisher) und **„Anfragen“**. „Anfragen“ zeigt die
  Zahl der wartenden Umsetzungen und listet alle Aufträge des Sprints in Freigabe.

Die Einzelfreigabe „✓ Freigeben“ und „↩ Zurückweisen“ auf der Seite „Aktionen“ bleiben unverändert.

**Printscreens: fehlen.** Dieser Lauf konnte AIdeation nicht im Browser starten. Die Beschreibung stammt aus dem Code der
Oberfläche. Die Aufnahmen stehen unter „Noch offen“.

## Wo du das findest

| Was | Wo in AIdeation | Sichtbar, wenn |
|---|---|---|
| „✓ Alle abnehmen (n)“ | Seite „Aktionen“, Kopf des Panels „Rückmeldungen der Agents“ | Recht „Ausführen“ und mindestens eine Umsetzung wartet |
| „✓ Alle abnehmen (n)“ | Sprints, Sprintmenü neben „Live schalten“ | Recht „Ausführen“ und mindestens eine Umsetzung dieses Sprints wartet |
| Reiter „Anfragen“ | Sprints, über der Auftragsliste des Sprints | immer; die Zahl nennt die wartenden Umsetzungen |

## Was passiert

### Alle abnehmen

1. Du klickst „✓ Alle abnehmen“.
2. Ein Dialog nennt die Anzahl und die Titel (höchstens zehn, der Rest als „… und n weitere“).
3. Mit „Abbrechen“ passiert nichts, es geht keine Anfrage an den Server.
4. Mit „Alle abnehmen“ nimmt der Server alle in einer Anfrage ab und weckt den Worker einmal. Der Worker mergt die
   Umsetzungen danach nacheinander in den Sprint-Branch.
5. Die Meldung oben nennt, wie viele Umsetzungen tatsächlich abgenommen wurden. Stand eine inzwischen nicht mehr in
   Freigabe (z. B. von jemand anderem zurückgewiesen), bleibt sie unberührt und zählt nicht mit.

Solange eine Sammelabnahme läuft (ab dem Klick, auch während der Dialog offen ist), sind alle Knöpfe „Alle abnehmen“
gesperrt – auf beiden Seiten. Nach Abbruch oder Fehler sind sie sofort wieder frei.

### Fremde Änderungen im Projektordner

Liegen im Ordner der Agents fremde Änderungen, warnt der Dialog wie bei der Einzelfreigabe („Git-Zustand nicht
sauber“). Abnehmen geht dann nur mit „Trotzdem alle abnehmen“ und einer Begründung. Ohne Bestätigung wird nichts
abgenommen. Die Prüfung gilt einmal für alle Umsetzungen zusammen.

### Register „Anfragen“

- Die Liste zeigt genau die Aufträge des Sprints im Status Freigabe, wartende zuerst.
- Spalte „Abnahme“: „Wartet auf Abnahme“ oder „Abgenommen – wird gemergt“. Abgenommene bleiben sichtbar, bis der Worker
  sie gemergt hat.
- Ein Klick auf eine Zeile führt zu dieser Umsetzung auf der Seite „Aktionen“. Dort stehen Vorschau, Freigeben und
  Zurückweisen.
- Der gewählte Reiter bleibt beim automatischen Nachladen stehen. Auch aufgeklappte Zeilen und „Aufträge hinzufügen“ im
  Reiter „Aufträge“ bleiben beim Reiterwechsel erhalten.

## Bedingungen

- **Recht „Ausführen“.** Ohne das Recht sind die Knöpfe nicht sichtbar. Der Server prüft das Recht zusätzlich (403).
- **Mindestens eine wartende Umsetzung.** Ohne wartende Umsetzung ist der Knopf nicht sichtbar.
- **Nicht über Sprints hinweg.** Der Knopf im Sprintmenü nimmt nur Umsetzungen dieses Sprints ab.

## Fehlermeldungen und Behebung

| Meldung oder Zustand | Ursache | Was du tust |
|---|---|---|
| „Freigeben ist gesperrt: …“ | Fremde Änderungen im Ordner der Agents, ohne Begründung bestätigt | im roten Git-Hinweis beheben oder mit Begründung „Trotzdem alle abnehmen“ |
| „Keine Umsetzung wartete mehr auf die Freigabe – nichts abgenommen.“ | Alle wurden inzwischen von jemand anderem bearbeitet | nichts, die Liste ist schon nachgeladen |
| „n Umsetzungen abgenommen … m standen nicht mehr in Freigabe.“ | Einzelne haben sich zwischen Anzeige und Klick geändert | nichts; die übrigen werden gemergt |
| Knopf fehlt | Recht „Ausführen“ fehlt oder nichts wartet | Admin nach dem Recht fragen |

## Noch offen

- **Printscreens fehlen:** (1) Seite „Aktionen“ mit „Alle abnehmen“, (2) Dialog mit Anzahl und Titeln, (3) Dialog mit
  Git-Warnung, (4) Sprint mit Reiter „Anfragen“ und Vermerk „wird gemergt“.
- **Browser nicht geprüft.** Der neue E2E-Test in `e2e/app.spec.ts` ist geschrieben, aber in diesem Lauf nicht gelaufen.
