# Benutzerhandbuch: Agents und Aufgaben im Dashboard

Dieses Kapitel beschreibt die Agent-Liste und das Diagramm „Offene Aufträge je Agent“ im Dashboard. Beide zeigen den Stand des **aktiven Projekts**. Wechselst du das Projekt, werden die Liste und das Diagramm neu geladen; Daten des vorherigen Projekts bleiben nicht stehen.

> **Screenshots:** Die Bilder für dieses Kapitel fehlen noch. Die Abschnitte unten beschreiben, was zu sehen ist. Die Platzhalter `[Bild 1]` bis `[Bild 3]` ersetzen, sobald die Oberfläche im Browser aufgenommen wurde.

---

## 1. Agent-Liste (Dashboard → Agent-Status)

Die Liste zeigt **jeden Agent des Projekts genau einmal**, aktiv oder inaktiv. Jeder Eintrag enthält:

| Element | Bedeutung |
| --- | --- |
| **Rollen-Icon** | Symbol passend zur Rolle. Der Alternativtext (Tooltip) nennt die Rolle, z. B. „Rolle: Entwickler“. |
| **Name** | Name des Agents. Bei eingebauten Rollen steht die Rolle nicht doppelt daneben. |
| **Rolle** | Deutsche Bezeichnung, z. B. „Entwickler“, „Tester“, „Eigene Rolle“. Dashboard-Assistent und Visionär tragen ihre eigene Bezeichnung. |
| **Rechte-Chips** | „Dateien ändern: ja/nein“ und „Befehle: ja/nein“. Sie stammen aus der Rechte-Tabelle in [`agents-und-rechte.md`](agents-und-rechte.md), Abschnitt 3. |
| **Hinweis „je nach Befehl“** | Erscheint nur, wenn die Rechte vom Befehl abhängen (Claude-CLI oder lokales Modell). Der Chip zeigt dann den Standardwert der Rolle. |
| **Aufgabe** | Kurze Zeile unter dem Namen (siehe Abschnitt 1.1). |
| **■ Abbrechen** | Erscheint nur bei einem **aktiven** Agent (außer beim Dashboard-Assistenten). Bricht den laufenden Lauf ab. |

**Klick auf einen Agent** (Name, Icon oder Zeile): Die Aktivität des Agents öffnet sich. Das Detail hat einen eigenen Verlaufseintrag (`#agents/<id>`); „Zurück“ schließt es wieder.

### 1.1 Aufgabe je Agent

| Zustand | Angezeigte Aufgabe |
| --- | --- |
| Agent arbeitet an einem Auftrag | Titel des laufenden Auftrags |
| Assistent wartet auf eine Antwort | `wartet · <Auftragstitel>` bzw. `wartet · Rückfrage` |
| Inaktiv, Worker online | **Inaktiv** |
| Inaktiv, Worker offline | **Worker offline** |

Der Worker-Status kommt vom Worker-Badge im Dashboard. Ist der Worker offline, läuft kein Agent, auch wenn in der Liste noch ein Auftrag steht.

### 1.2 Rollen-Icons

Jede Rolle hat ein eigenes Icon. Die Rollen sind:

| Rolle | Icon-Motiv |
| --- | --- |
| Auftragsautor | Stift |
| Entwickler | spitze Klammern `< >` |
| Tester | Reagenzglas |
| Visueller Tester | Kamera |
| Reviewer | Lupe mit Häkchen |
| Dokumentierer | Dokument |
| Bug-Wächter | Käfer |
| Handbuch-Autor | aufgeschlagenes Buch |
| Benutzerhandbuch-Autor | Buch mit Person |
| Eigene Rolle (und alle unbekannten Rollen) | Kreis mit Strahlen |

Ein Agent ohne bekannte Rolle erscheint als **„Eigene Rolle“**.

### 1.3 Rechte je Rolle (Standardwert)

| Rolle | Dateien ändern | Befehle | Hinweis „je nach Befehl“ |
| --- | --- | --- | --- |
| Auftragsautor | nein | nein | – |
| Bug-Wächter | nein | nein | – |
| Entwickler | ja | ja | – |
| Tester | ja | ja | ja |
| Visueller Tester | nein | nein | – |
| Reviewer | nein | ja | ja |
| Dokumentierer | nein | nein | ja |
| Handbuch-Autor | nein | nein | ja |
| Benutzerhandbuch-Autor | nein | nein | ja |
| Eigene Rolle | nein | nein | – |

**Wichtig:** Die Rechte beschreiben **Agents**, nicht Benutzerrollen. Ob du selbst einen Auftrag anlegen oder einen Agent ändern darfst, hängt von deiner Benutzerrolle ab, nicht von diesen Chips.

---

## 2. Diagramm „Offene Aufträge je Agent“

Das Diagramm steht im Dashboard unter der Agent-Liste. Es zeigt, wie die **offenen Aufträge** auf die Agents verteilt sind.

- **Offen** heißt: Status nicht „erledigt“ und nicht „abgelehnt“.
- Jeder Agent bekommt einen Balken mit **Anzahl** und **Anteil** an den offenen Aufträgen.
- Aufträge ohne zugewiesenen Agent erscheinen als eigener Balken **„Ohne Agent“**.
- Die Summe aller Balken einschließlich „Ohne Agent“ ergibt genau die Zahl der offenen Aufträge im Projekt.
- Die Balken sind einfache HTML- und CSS-Elemente auf derselben Share-Bar wie die Prüfergebnisse im Dashboard.

**Klick auf einen Balken:** Die Auftragsliste öffnet sich mit dem Filter **Agent = dieser Agent**. Der Filter ist in der Spalte „Agent“ sichtbar. Über „Alle Aufträge“ im Kopf des Diagramms kommst du ohne Filter in die Liste.

### 2.1 Zustände des Diagramms

| Zustand | Was du siehst |
| --- | --- |
| Projekt hat Agents und offene Aufträge | Balken je Agent mit Anzahl und Anteil, dazu „Ohne Agent“ |
| Projekt hat Agents, aber keine offenen Aufträge | Balken sind leer; darunter der Hinweis **„Keine offenen Aufträge.“** |
| Projekt hat keine Agents | Kein Diagramm, sondern der Hinweis **„Keine Agents für dieses Projekt“** |

Der zweite und dritte Zustand sind verschieden. „Keine offenen Aufträge“ heißt: Es gibt Agents, aber nichts zu tun. „Keine Agents“ heißt: Im Projekt ist kein Agent eingerichtet.

---

## 3. Bedienung und Grenzen

- **Aktualisierung:** Die Daten folgen dem bestehenden Polling. Es gibt keine Live-Animation und kein Echtzeit-Streaming. Der Worker wird etwa alle 10 Sekunden abgefragt.
- **Keine Auswertung von Aufwand, Tokens oder Kosten** pro Agent. Dafür gibt es die Verbrauchsansicht.
- **Bestehende Funktionen bleiben:** Die Share-Bar der Prüfergebnisse, der Abbrechen-Button und der Klick auf die Agent-Aktivität funktionieren wie bisher.
- **Review-Container (nur Administratoren):** Der Container sieht weder die `.env` noch die Haupt-Datenbank. Er bekommt nur einen eigenen Review-DB-User ohne Superuser-Rechte und einen Projekt-Cache. Für Projekte mit eigener Datenbank schlägt der Review-Slot derzeit fehl, statt auf die Haupt-Zugänge zurückzufallen. Eine Lösung ist noch offen.

---

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Agent zeigt „Worker offline“ | Der Worker läuft nicht. Prüfe den Worker-Dienst auf dem Host (siehe [`laufzeit.md`](laufzeit.md)). |
| Ein Agent fehlt in der Liste | Der Agent gehört zu einem anderen Projekt oder ist nicht angelegt. Prüfe, ob das richtige Projekt aktiv ist. |
| Rechte-Chip zeigt „nein“, der Agent darf aber Befehle ausführen | Das Chip zeigt den Standardwert der Rolle. Der Befehl des Agents (Claude-CLI oder lokales Modell) kann abweichen. Der Hinweis „je nach Befehl“ weist darauf hin. |
| Review-Slot zeigt „failed“ mit der Meldung „Kein Review-DB-User eingerichtet (DEV_LOG_REVIEW_DATABASE_URL …)“ | Nur für Administratoren. Der Review-Container bekommt keine Haupt-Zugänge. Ohne eigenen Review-DB-User startet er nicht. Lösung: `bash scripts/setup-review-db.sh` ausführen, den ausgegebenen Wert als `DEV_LOG_REVIEW_DATABASE_URL` setzen und den Worker neu installieren (siehe [`laufzeit.md`](laufzeit.md)). |
| Review-Slot zeigt „failed“ mit „Der Review-DB-User muss ein eigener User …“ oder „DEV_LOG_REVIEW_DATABASE_URL braucht User, Passwort …“ | Nur für Administratoren. Die Review-URL zeigt auf die Haupt-Datenbank oder ist unvollständig. Eine eigene Basis-Datenbank (z. B. `aideation_review`) mit eigenem User und Passwort eintragen. |

| Test- oder Coverage-Schritt zeigt „Abdeckung nicht gemessen: Vorbereitungsschritt „…“ im test-Skript … ist nicht erlaubt“ | Die Tests laufen trotzdem. Nur die Messung entfällt, weil das `test`-Skript einen Vorbereitungsschritt enthält, der nicht erlaubt ist (erlaubt: `npm run`, `npm ci`, `tsc`, `ng build`, `vite build`). Kein Fehler des Auftrags. Abhilfe: Testbefehl je Auftrag mit `npx tsx --test <Dateien>` verwenden, dann misst AIdeation direkt. |
| Test schlägt fehl, obwohl der Code stimmt, und die Ausgabe nennt eine fehlende Umgebungsvariable (z. B. Datenbank-URL) | Projektcode bekommt nur eine feste Liste von Variablen (Abschnitt 5). Geheimnisse wie `DEV_LOG_*` oder `DATABASE_URL` fehlen immer. Die Variable muss in die Allowlist (`src/runner/project-command.ts`) aufgenommen werden, ein Rückfall auf die Worker-Umgebung gibt es nicht. Das ist eine Entwicklungsaufgabe, nicht etwas, das du in der Oberfläche einstellst. |

Offener Punkt: Ein Auftrag kann blockiert sein, ohne dass ein Schritt fehlgeschlagen ist. Die Aufgabenzeile liest den Zustand dann nur aus dem Worker-Status, nicht aus einem Schritt. Dieser Fall ist noch nicht behoben.

---

## 5. Projektcode und Umgebung (Worker)

Dieser Abschnitt betrifft keinen Bildschirm, sondern das Verhalten des Workers beim Ausführen von Projektcode. Es gibt dafür keine Einstellung in der Oberfläche.

**Was gilt:** Tests (Auftrags-Testlauf, Test-Gate, Komplettlauf), die Coverage-Messung und die Befehle des Chat-Assistenten laufen mit einer **Allowlist** der Worker-Umgebung. Enthalten sind `PATH`, `HOME`, `TMPDIR`, Locale, Terminal, `CI`, `NODE_ENV` und die Präfixe `LC_*`, `NPM_CONFIG_*`, `PLAYWRIGHT_*`, `DOCKER_*`, `XDG_*`, `NVM_*`.

**Was nie weitergegeben wird:** `DEV_LOG_*` sowie alle Namen mit SECRET, TOKEN, PASSWORD, API_KEY, DATABASE_URL, PRIVATE_KEY, ACCESS_KEY oder CREDENTIAL. Auch wenn ein Projekt so eine Variable für seine Tests braucht, bekommt es sie nicht.

**Git des Workers:** Git und `gh` laufen mit derselben Allowlist. GitHub-Tokens bleiben erlaubt, damit der Push funktioniert. Git-Hooks sind aus (`core.hooksPath` zeigt auf `/dev/null`). Alle Commits des Workers entstehen mit `--no-verify`. Ein Pre-Commit-Hook im Projekt läuft daher nicht. Lint und Format müssen über das Test-Gate geprüft werden.

**Agent-CLIs (Claude, Codex) und Deploy-Befehle** behalten ihre Umgebung. Nur `DEV_LOG_*` wird entfernt, weil sie ihre eigenen API-Schlüssel bzw. Hoster-Zugänge brauchen.

**Coverage-Messung, Bedingungen:**
- Testbefehle `npx tsx --test <Dateien>` oder `node --test …` werden direkt mit Abdeckung gemessen, ohne Skript und ohne Vorbereitung.
- Läuft der Test über ein `test`-Skript mit Vorbereitungsschritten, werden diese nur ausgeführt, wenn sie zur erlaubten Liste gehören (`npm run`, `npm ci`, `tsc`, `ng build`, `vite build`), und ohne Verkettung mit `&&`, `;`, Pipes, Umleitungen oder `$`. Sonst entfällt die Messung, und der Schritt nennt den Grund. Die Tests selbst laufen weiter.

---

## Verwandte Dokumente

- [`agents-und-rechte.md`](agents-und-rechte.md): Rechte-Tabelle, Trigger und Sicherheitsregeln
- [`workflows.md`](workflows.md): Ablauf der Agents im Auftrag
- [`laufzeit.md`](laufzeit.md): Worker und Betrieb
