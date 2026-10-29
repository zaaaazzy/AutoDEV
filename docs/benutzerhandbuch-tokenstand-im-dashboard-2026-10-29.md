# Tokenstand im Dashboard: Hinweis bei erreichtem Nutzungslimit (Auftrag b42e30c8, 29.10.2026)

Bisher war ein erreichtes Nutzungslimit eines Agent-Kontos (z. B. Claude) nur in den Schritt-Protokollen sichtbar. Jetzt zeigt das **Dashboard** einen Hinweis mit Reset-Zeit, einem Link zur Bezahl- bzw. Verbrauchsseite des Anbieters und, wenn du es darfst, einer Aktion zum Fortsetzen.

## Wann der Hinweis erscheint

- Der Hinweis erscheint oben im Dashboard, direkt unter dem Git-Hinweis.
- Er erscheint nur, wenn das Konto eines Anbieters ein Nutzungslimit gemeldet hat **und** der gemeldete Reset-Zeitpunkt noch in der Zukunft liegt.
- Nach dem Reset verschwindet er von selbst. Du musst nichts tun. Die Anzeige aktualisiert sich etwa jede Minute.
- Ist kein Limit aktiv, ist im Dashboard nichts zu sehen.

**Erkannt werden:**

| Anbieter | Erkennung | Bezahlseite (fest im Code) |
|---|---|---|
| Claude | Ja, Meldung der Claude-CLI („You've hit your … limit“) | https://claude.ai/settings/usage |
| GitHub Copilot | Nur, wenn die CLI eine solche Meldung ausgibt | https://github.com/settings/copilot |
| Gemini | Nur, wenn die CLI eine solche Meldung ausgibt | https://console.cloud.google.com/billing |

Ein lokales Modell oder ein eigenes Wrapper-Skript als Befehl (z. B. `run-claude.sh`) ist kein erkannter Anbieter. In diesem Fall pausieren die Aufträge wie bisher, aber das Dashboard zeigt **keinen** Hinweis.

## Was du siehst

Der Hinweis trägt die Überschrift **„Token bzw. Nutzungslimit aufgebraucht“**. Darunter steht je Anbieter eine Zeile:

> Claude · Limit erreicht – Agents mit Claude pausieren bis 29.10., 20:53 Uhr.

Die Uhrzeit ist der Reset laut Meldung, plus eine kleine Reserve von 3 Minuten. Enthält die Meldung keine lesbare Uhrzeit, gilt eine Pause von einer Stunde ab Erkennung, ohne Reserve. Die Zeile zeigt dann diese Uhrzeit ebenfalls an. Die Zeile ganz ohne Uhrzeit („Limit erreicht – Agents mit Claude pausieren.“) gibt es im Code, sie erscheint aber nicht, weil der Hinweis nur bei gesetzter Rücksetzzeit angezeigt wird.

<!-- PRINTSCREEN 1: Dashboard mit dem Hinweis „Token bzw. Nutzungslimit aufgebraucht“ und der Zeile für Claude (Limit erreicht, Uhrzeit sichtbar) -->

## Aktionen

### „Limit erhöhen bei Claude“

- Erscheint bei jedem erreichten Limit für **alle** Benutzer.
- Öffnet die Verbrauchsseite des Anbieters in einem neuen Tab.
- Hier erhöhst oder bezahlst du das Limit beim Anbieter. Im Dashboard passiert dabei nichts.

### „Limit erhöht – fortsetzen“

Diese Schaltfläche erscheint nur, wenn **beide** Bedingungen gelten:

1. Deine Rolle umfasst **„Ausführen“**.
2. Du hast Zugriff auf **alle Projekte**. Das Agent-Konto gilt für alle Projekte, deshalb wird eine Freigabe nicht für einzelne Projekte erteilt.

Bei Klick passiert Folgendes:

- Das Limit dieses Anbieters wird im Dashboard zurückgesetzt.
- Aufträge, die nur wegen des Limits warten (Vermerk „Unterbrochen: Nutzungslimit des Agent-Kontos erreicht“), starten sofort wieder.
- Darunter erscheint die Meldung: „Claude: fortgesetzt, N wartende Aufträge starten wieder.“ Bei einem Fehler: „Claude: Fortsetzen ist nicht möglich.“

**Wichtig:** Erst klicken, wenn du das Limit beim Anbieter tatsächlich erhöht hast. Sonst scheitert der nächste Lauf erneut am Limit, und der Hinweis erscheint wieder.

Ist kein Limit vermerkt (z. B. weil es schon zurückgesetzt wurde), antwortet der Server mit „Für diesen Anbieter ist kein Limit vermerkt.“ Die Schaltfläche erscheint in diesem Fall gar nicht.

<!-- PRINTSCREEN 2: Hinweis mit beiden Schaltflächen („Limit erhöhen bei Claude“ und „Limit erhöht – fortsetzen“), angemeldet als Benutzer mit Rolle „Ausführen“ und Zugriff auf alle Projekte -->
<!-- PRINTSCREEN 3: Hinweis nach Klick auf „Limit erhöht – fortsetzen“ mit der Statusmeldung -->
<!-- PRINTSCREEN 4 (optional): Hinweis für einen Benutzer ohne Rolle „Ausführen“ bzw. mit eingeschränktem Projektzugriff: nur „Limit erhöhen bei Claude“, ohne „fortsetzen“ -->

## Bedingungen und Grenzen

- **Pre-Sprint-Phasen** warten bis zum gemeldeten Reset weiter. „Fortsetzen“ gibt sie **nicht** vorzeitig frei. Sie laufen zur gemeldeten Zeit an.
- **Nur Aufträge** werden durch „Fortsetzen“ freigegeben, die wegen des Limits warten. Andere Fehler bleiben unverändert.
- **Limit-Meldungen erzeugen keine Bugs.** Wenn ein Lauf am Limit scheitert, wird er als Unterbrechung gewertet und nicht als Fehler im Code.
- **Keine Zahlung im Dashboard.** Der Link führt nur zur Seite des Anbieters. Dort musst du dich anmelden und das Limit erhöhen.
- **Zeitzone:** Die Uhrzeit wird in der Zeitzone des Browsers angezeigt (Format: Tag.Monat., Uhrzeit).
- **Nur `https`-Links.** Links kommen ausschließlich aus der festen Anbieterliste des Servers, nie aus der Ausgabe einer CLI.
- **Kein Kostenlimit.** Dieser Hinweis hat nichts mit dem Budget unter „Einstellungen → Budget“ (Kostenlimit in USD) zu tun. Das Budget begrenzt Kosten in eigenen Einstellungen. Das Nutzungslimit kommt vom Anbieter.

## Wo der Zustand gespeichert wird

Für Entwickler und Betrieb: Pro Anbieter steht ein Eintrag in `app_settings` mit dem Schlüssel `provider_limit:<anbieter>` (z. B. `provider_limit:claude`). Der Eintrag enthält `since` (Beginn) und `resetAt` (Reset). Ein erfolgreicher Lauf oder „Fortsetzen“ löscht den Eintrag. Die Details stehen in `docs/erm.md` und `docs/tokenstand-im-dashboard-2026-10-29.md`.

## Offen

- **Printscreens fehlen.** Die App lief in dieser Umgebung nicht, es ist kein Browser installiert, und Shell-Befehle für Agents sind eingeschränkt. Die Bildstellen sind oben mit `PRINTSCREEN 1–4` markiert. Sie sind nicht erstellt. Bitte mit laufender App und angemeldeten Benutzern (Rolle „Ausführen“ und ohne Rolle) nachholen.
- **Oberfläche nicht im Browser geprüft.** Die Beschreibung stammt aus `provider-limit-alert.component.ts`, `provider-limits.ts` (Frontend), `src/api/provider-limits.ts` und `src/core/provider-limits.ts`. Diese Dateien sind in diesem Lauf gelesen und mit den Angaben abgeglichen.
- **Tests nicht in diesem Lauf ausgeführt.** Die Angaben zu `src/core/provider-limits.test.ts` und `frontend/src/app/features/dashboard/provider-limits.spec.ts` stammen aus dem Entwicklerbericht.
- **Pre-Sprint-Aussage nicht im Code belegt.** Der Aufruf „Fortsetzen“ ändert nur Aufträge (`development_items`). Dass Pre-Sprint-Phasen bis zum Reset weiterwarten, folgt daraus, ist aber nicht im Code selbst geprüft.
