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

### 1.4 Geheimnisse sind für alle Agents gesperrt

Zugangsdaten und Schlüssel im Projekt bleiben für jeden Claude-Agent unlesbar, unabhängig von der Rolle. Das gilt auch für den Visionär (nur lesend), für Routinen und für den Chat-Assistenten mit Vollzugriff. Gesperrt sind unter anderem:

- Umgebungsdateien (`.env`, `.env.example`, `config/.env.production`), auch in Unterordnern,
- Zertifikate und Schlüssel (`*.pem`, `*.key`) sowie private SSH-Schlüssel (`id_rsa`, `id_ed25519`, `id_ecdsa`),
- Zugangsdaten-Dateien mit Tokens: `.npmrc` (Registry-Tokens), `.netrc` und `.git-credentials`, im Projekt und im Benutzerordner (`~/.npmrc` usw.),
- SSH-, AWS- und GnuPG-Ordner im Projekt und im Benutzerordner.

Gezählt wird nur der ganze Dateiname. `npmrc.md`, `environment.ts` und `keyboard.ts` bleiben lesbar.

Die Sperre greift beim Lesen (Lese-Werkzeug), bei der Suche (Grep, auch über Pfad und Dateifilter) und beim Auflisten (Glob). Schreiben lässt sich keine dieser Dateien, auch `.npmrc` nicht. Agents können also keine Registry-Einstellungen oder Zugangsdaten anlegen.

Shell-Befehle, die einen dieser Namen enthalten (`cat .env`, `grep … .npmrc`, `cat ~/.netrc`), lehnt AIdeation ab. Die Meldungen lauten:

- Lesen oder Suchen: „<Pfad>: Geheimnisse (.env, Schlüssel, Zertifikate) sind für Agents gesperrt.“
- Shell: „Befehle mit Zugriff auf Geheimnisse (.env, Schlüssel) sind gesperrt.“

Die Meldung nennt nur den Pfad, nie den Inhalt. Der lokale Ollama-Agent nutzt dieselbe Namensliste für seine Datei-Werkzeuge.

**Bedingungen und Grenzen:**

- Bei einer Suche über einen ganzen Ordner (Grep ohne bestimmte Datei) prüft AIdeation nicht jede Datei einzeln. Dort wirken nur die Sperren der Claude-CLI.
- Die Shell-Prüfung sucht den Namen im Befehlstext. Ein Befehl, der `.env` nur als Teil eines anderen Namens enthält (etwa `x.environment`), wird deshalb auch abgelehnt. Das ist bewusst strenger.
- Braucht ein Auftrag einen Wert aus einer `.env`-Datei, formuliere ihn ohne Wert und trage den Wert selbst im Terminal ein. Ein Agent soll ihn nicht lesen.

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

- **Aktualisierung:** Die Daten folgen dem bestehenden Polling. Es gibt keine Live-Animation und kein Echtzeit-Streaming. Der Worker wird etwa alle 10 Sekunden abgefragt, die Schritte eines laufenden Agents alle 3 Sekunden.
- **Nachladen nach einem Agent-Lauf:** Endet ein Schritt (oder startet ein neuer Auftrag), lädt die Oberfläche das Projekt im Hintergrund nach, ohne dass du die Seite wechseln musst. Das gilt, wenn ein laufender Schritt fertig wird (Erkennung nach höchstens 3 s) oder wenn sich die Menge der laufenden Aufträge im Worker ändert (höchstens 10 s). Danach zeigen Auftragsstatus, Sprint-Kopfzeile und das Banner „Alle Aufträge sind durch – der Sprint wartet auf dein Go“ den neuen Stand. Offene Zeilen, Dialoge und Eingaben in „Aufträge hinzufügen“ bleiben dabei stehen. Schlägt das stille Nachladen fehl, erscheint keine Fehlermeldung, und die bisherigen Daten bleiben sichtbar. Wechselst du während des Nachladens das Projekt, wird die Antwort des alten Projekts verworfen.
- **„Aufträge hinzufügen“ (Sprint-Ansicht):** Die Liste der offenen und abgebrochenen Aufträge, die noch in keinem Sprint stehen, lässt sich aufklappen. [Bild 3.3a: Sprint-Ansicht mit zugeklappter und geöffneter Liste „Aufträge hinzufügen“]
  - **Vorgabe:** Ist der Sprint leer, ist die Liste offen. Hat er Aufträge, ist sie zu. Mit dem Schalter der Liste änderst du das von Hand.
  - **Bleibt offen:** Eine von dir geöffnete Liste bleibt beim Nachladen (siehe oben) und beim Übernehmen eines Auftrags offen. Ein Refresh klappt sie nicht mehr zu.
  - **Zurück auf die Vorgabe:** Erst wenn der Sprint leer wird oder wieder Aufträge bekommt, gilt die Vorgabe wieder.
  - **Reihenfolge:** Offene Aufträge stehen oben, abgebrochene darunter. Eine Spalte „Herkunft“ zeigt „Offen – noch in keinem Sprint“ bzw. „Abgebrochen“. Abgebrochen sind Aufträge mit Status „blockiert“ oder mit Abbruch aus einem Sprint.
  - **Auswahl:** Gewählte Aufträge bleiben markiert, bis du sie übernimmst oder die Auswahl löschst. Hat ein Agent einen gewählten Auftrag inzwischen in einen Sprint eingeplant, fällt er aus der Auswahl heraus.
  - **Nur in offenen Sprints:** Aufträge lassen sich nur in geplante oder aktive Sprints hineinnehmen. Im Review, nach Abschluss oder bei abgebrochenem Sprint ist das Hineinnehmen gesperrt. Dafür braucht es die Rolle „Planung“.
- **Keine Auswertung von Aufwand, Tokens oder Kosten** pro Agent. Dafür gibt es die Verbrauchsansicht.
- **Dateibefehle in der Shell sind gesperrt:** Agents können Dateien nicht mehr über Shell-Befehle anlegen, ändern oder löschen. Gesperrt sind `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`, außerdem `ln`, `tee`, `truncate`, `install`, `unlink`, `shred`, `patch`, `dd` sowie `find` mit `-delete`, `-exec` oder `-fprint`. Das gilt für jeden Teil einer Befehlskette (`;`, `&&`, `||`, `|`) und auch, wenn der Befehl mit Pfad (`/bin/rm`), in Anführungszeichen oder mit Präfix (`xargs`, `command`, `sudo`) geschrieben ist. `sed` ist ganz gesperrt, also auch zum bloßen Lesen. Dateien ändern Agents nur über die Datei-Werkzeuge; dort prüft AIdeation die Rechte der Rolle und den erlaubten Ordner. Grund: Die Claude-CLI gibt die ersten sieben Befehle im Modus „Dateien bearbeiten ohne Rückfrage“ ohne Prüfung frei, also auch außerhalb des erlaubten Ordners. Eigene Agent-Befehle und Routinen, die einen dieser Befehle nutzen, schlagen deshalb fehl. Lesen geht über das Lese-Werkzeug.
- **Befehle werden wie in Bash zerlegt:** Anführungszeichen und Escapes zählen. `'…'`, `"…"` und `$'…'` löst AIdeation wie die Shell auf, damit Quoting keinen Dateibefehl oder keine Umleitung versteckt. Gesperrt sind: escapte Anführungszeichen (`\'`, `\"`), offene Anführungszeichen, ein Backslash am Zeilenende, `$(…)`, Backticks, Subshells, `&` am Ende, Heredocs (`<<`), `${…}` und Shell-Schlüsselwörter an Befehlsposition (`if`, `for`, `while`, `!`, `{ … }`). Wer einen eigenen Agent-Befehl schreibt, setzt Argumente mit Leerzeichen in ganze Anführungszeichen, z. B. `git log --grep='a b'`, und verzichtet auf Escapes.
- **Werkzeug-Regeln im Agent-Befehl (nur Administratoren):** Ein Agent-Befehl kann `--allowedTools` bzw. `--disallowedTools` enthalten (auch als `--allowed-tools=…`). Die Datei-Rechte und der erlaubte Ordner kommen trotzdem immer aus der Zuweisung des Agents (z. B. „Dateien anlegen“ mit Ordner `frontend`). Ein `--disallowedTools` allein gibt also keine vollen Datei-Rechte frei; es sperrt nur zusätzliche Werkzeuge. Mit eigenem `--allowedTools` werden keine zusätzlichen Freigaben angehängt, und Datei-Rechte werden dadurch nicht erweitert. Eigene Sperren werden mit den Sperren von AIdeation zu einem einzigen `--disallowedTools` zusammengeführt. Die Oberfläche zeigt diese Regeln nicht an; Grundlage ist `docs/agents-und-rechte.md`, Abschnitt „Eigene Werkzeug-Regeln im Befehl“.
- **Rechte gelten für den Pfad, nicht für die Schreibweise:** Ein Schrägstrich am Ende der Adresse ändert an den Rechten nichts. Wer nur die Rolle „Planung“ hat, bekommt für `PATCH …/development/<id>/` mit `agentId` (Agent starten), für `…/approve/` (Freigabe) und für `…/git-sync/` (Sprint-Sync) dieselbe Antwort wie ohne Schrägstrich: 403. Zum Starten eines Agents oder zum Freigeben braucht es die Rolle „Ausführen“.
- **Abbrechen und Zeitlimit stoppen den Agent wirklich:** Über „■ Abbrechen“ (nur bei einem aktiven Agent) oder nach dem Zeitlimit je Schritt (Standard 30 min) erhält der Agent ein Stopp-Signal. Es erreicht das laufende Modell, jedes Datei-Werkzeug und laufende Befehle samt ihren Prozessen, etwa Dev-Server oder Testläufer. Danach startet kein weiteres Werkzeug, und es wird keine Datei mehr geschrieben. Commit und Rückkehr auf den Basis-Branch laufen erst, wenn der Agent wirklich beendet ist. Dafür wartet der Schritt ohne zeitliche Obergrenze. Tokens und Kosten des abgebrochenen Laufs bleiben erhalten. Ein Abbruch gilt weder als Erfolg noch wird er wiederholt. Ein Zeitlimit wird wie ein vorübergehender Fehler einmal nach 30 s wiederholt, wenn das Budget es erlaubt.
- **Bestehende Funktionen bleiben:** Die Share-Bar der Prüfergebnisse, der Abbrechen-Button und der Klick auf die Agent-Aktivität funktionieren wie bisher.
- **Review-Container (nur Administratoren):** Der Container sieht weder die `.env` noch die Haupt-Datenbank. Er bekommt nur einen eigenen Review-DB-User ohne Superuser-Rechte und einen Projekt-Cache. Für Projekte mit eigener Datenbank schlägt der Review-Slot derzeit fehl, statt auf die Haupt-Zugänge zurückzufallen. Eine Lösung ist noch offen.
- **AIdeation neu starten (nur Administratoren):** Aktionen → System → „AIdeation neu starten“. Neuer Code und neue Agents werden erst mit dem Neustart geladen. Bedingungen:
  - **Start:** Der Worker wartet, bis keine Aufgabe mehr läuft, höchstens 15 Minuten. Danach startet der Neustart auch dann, und was noch läuft, wird nach dem Neustart fortgesetzt.
  - **Arbeitsordner:** AIdeation muss auf `main` ausgecheckt sein (oder auf dem Branch in `DEV_LOG_RESTART_BRANCH`; `*` erlaubt jeden Branch). Nicht committete Änderungen an versionierten Dateien verhindern den Neubau. Der Fehler steht im Menü, AIdeation läuft unverändert weiter. Nicht versionierte Dateien stören nicht.
  - **Abhängigkeiten:** Stimmt der installierte Stand des Workers nicht mit `package-lock.json` überein, fehlt er ganz oder fehlt ein Paket, läuft vor dem Neubau `npm ci --ignore-scripts` im AIdeation-Ordner (höchstens 10 Minuten). Optionale Pakete fremder Plattformen zählen nicht als Abweichung. Das Menü zeigt dann „Aktualisiert die Abhängigkeiten des Workers“.
  - **Scheitert `npm ci`:** Der Neustart ist „fehlgeschlagen“. Es wird nichts neu gebaut, der Worker beendet sich nicht, und die Ausgabe steht gekürzt im Menü. Ein neuer Neustart ist sofort möglich.
  - **Neubau:** Danach `docker compose up -d --build`. Scheitert er, läuft AIdeation mit dem bisherigen Stand weiter.
  - **Gesundheitsprüfung:** Nach dem Neubau prüft der Worker bis zu 2 Minuten, ob AIdeation antwortet. Wenn nicht, kehrt er auf das vorherige Abbild zurück und schickt eine Push-Nachricht. Der Worker startet sich dann nicht neu.
  - **Erfolg:** Der Worker startet neu und lädt dabei den neuen Code und die neuen Agents. Das Menü zeigt danach den Abschluss des Neustarts.
  - **Unter Windows:** Der Worker startet über `scripts\run-with-env.ps1` neu, das nach dem Beenden 5 Sekunden wartet und dann weiterläuft. Bewusste Stopps und Fehler starten den Worker nicht neu. Ob der Worker nach einem Neustart innerhalb von 30 Sekunden wieder läuft, ist auf einem echten Windows-Rechner noch nicht geprüft. Ältere Installationen brauchen einmal `scripts\install-worker.ps1` (siehe [`installation.md`](installation.md), Abschnitt „Neustart unter Windows“).
  - **Neustart hängt:** Bleibt der Status auf „restarting“, kommt der Worker nicht zurück. Ein neuer Neustart ist erst 10 Minuten nach dem Beginn möglich. Bis dahin meldet AIdeation „Ein Neustart läuft bereits.“

---

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Agent zeigt „Worker offline“ | Der Worker läuft nicht. Prüfe den Worker-Dienst auf dem Host (siehe [`laufzeit.md`](laufzeit.md)). |
| Ein Agent fehlt in der Liste | Der Agent gehört zu einem anderen Projekt oder ist nicht angelegt. Prüfe, ob das richtige Projekt aktiv ist. |
| Rechte-Chip zeigt „nein“, der Agent darf aber Befehle ausführen | Das Chip zeigt den Standardwert der Rolle. Der Befehl des Agents (Claude-CLI oder lokales Modell) kann abweichen. Der Hinweis „je nach Befehl“ weist darauf hin. |
| Agent-Lauf meldet „ist für Agents gesperrt – Dateien nur mit den Datei-Werkzeugen anlegen, ändern oder löschen“ | Der Befehl enthält einen Dateibefehl wie `rm`, `mv`, `cp`, `sed` oder `touch` (siehe Abschnitt 3). Der Agent muss die Änderung über die Datei-Werkzeuge machen. Ändert sich ein eigener Agent-Befehl oder eine Routine, den Befehl umstellen oder den Schritt entfernen. Die Meldung nennt den Teilbefehl, der gesperrt ist. |
| Agent-Lauf meldet „Escapte Anführungszeichen (\' bzw. \") sind gesperrt“, „Offene Anführungszeichen …“ oder „Der Befehl lässt sich nicht eindeutig zerlegen …“ | Der Befehl ist so geschrieben, dass AIdeation ihn nicht sicher lesen kann (siehe Abschnitt 3). Argumente in ganze Anführungszeichen setzen (`'…'` oder `"…"`), statt mit `\'` oder `\"` zu escapen, Backslashes am Zeilenende entfernen und Befehle in einfache Teilbefehle aufteilen. Die Meldung nennt den Grund. |
| Agent-Lauf meldet „…: Geheimnisse (.env, Schlüssel, Zertifikate) sind für Agents gesperrt.“ oder „Befehle mit Zugriff auf Geheimnisse (.env, Schlüssel) sind gesperrt.“ | Der Agent wollte eine Datei mit Zugangsdaten lesen oder durchsuchen, etwa `.env`, `*.pem`, `.npmrc`, `.netrc` oder `.git-credentials`. Das ist gewollt. Den Auftrag so umformulieren, dass der Wert nicht gebraucht wird, und einen Wert selbst im Terminal eintragen (Abschnitt 1.4). Die Meldung nennt nur den Pfad, nie den Inhalt. |
| Agent-Lauf meldet „Abgebrochen: Der Agent wurde gestoppt.“ | Jemand hat „■ Abbrechen“ genutzt, oder der Worker wurde beendet. Der Lauf gilt nicht als Erfolg und wird nicht automatisch wiederholt. Prüfe vor einem neuen Start, welche Dateien der Agent bereits geschrieben hat. |
| Agent-Lauf meldet „Zeitlimit erreicht“ | Der Schritt lief länger als das Zeitlimit (Standard 30 min je Schritt). Er wird einmal nach 30 s wiederholt, wenn das Budget es erlaubt. Scheitert auch der zweite Versuch, den Auftrag in kleinere Teile aufteilen. |
| „AIdeation neu starten“ endet mit „fehlgeschlagen“ und der Meldung „npm ci --ignore-scripts ist fehlgeschlagen (Exit-Code …)“ | Die Abhängigkeiten des Workers konnten nicht auf den Stand von `package-lock.json` gebracht werden. Nichts wurde neu gebaut, AIdeation läuft unverändert weiter. Die gekürzte Ausgabe steht im Menü. Im AIdeation-Ordner `npm ci --ignore-scripts` von Hand ausführen und die Fehlermeldung prüfen, etwa Netzzugang, Registry oder ein Lockfile, das nicht zu `package.json` passt. Danach den Neustart erneut anfordern. |
| „AIdeation neu starten“ endet mit „fehlgeschlagen“ und dem Hinweis „Nicht neu gebaut: … Nicht committete Änderungen …“ oder „Im AIdeation-Ordner ist „…“ ausgecheckt, live gehen darf nur „…““ | Der AIdeation-Ordner ist nicht bereit für den Live-Stand. Änderungen committen oder verwerfen bzw. den erlaubten Branch auschecken (`main` oder der Branch in `DEV_LOG_RESTART_BRANCH`). Danach den Neustart erneut anfordern. |
| „AIdeation neu starten“ steht auf „restarting“, und der Worker läuft nicht wieder (Windows) | Die Aufgabe `AIdeationWorker` startet den Worker nach dem Beenden nur über `run-with-env.ps1`. Ist dieses Skript nicht mehr die Startdatei der Aufgabe (ältere Installation), führe `scripts\install-worker.ps1` einmal erneut aus. Ein Stopp per Hand oder ein Fehler startet den Worker nicht neu, dann die Aufgabe in der Aufgabenplanung manuell starten. Nach 10 Minuten lässt sich der Neustart erneut anfordern. |
| Agent-Start, Freigabe oder Sprint-Sync per API endet mit 403, obwohl die Adresse stimmt (auch mit Schrägstrich am Ende) | Die Sitzung hat nur die Rolle „Planung“. Starten, Freigeben und Git-Sync brauchen „Ausführen“ (siehe `agents-und-rechte.md`, Abschnitt 6.1). Ein anderer Pfad oder ein Schrägstrich hilft nicht. |
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

**Git des Workers:** Git und `gh` laufen mit derselben Allowlist. GitHub-Tokens bleiben erlaubt, damit der Push funktioniert. Git-Hooks sind aus: Der Worker setzt `core.hooksPath` auf `/dev/null` und gibt git nur die gefilterte Umgebung mit (ohne `DEV_LOG_*`). Ein Hook im Projekt (`.git/hooks`, `.husky`, `.githooks`) läuft daher bei Commits und Merges des Workers nicht, auch nicht bei Merges. Lint und Format müssen über das Test-Gate geprüft werden.

**Hook-Ordner sind für Agents gesperrt:** `.git/`, `.husky/` und `.githooks/` lassen sich weder anlegen noch ändern, auch nicht in Unterordnern oder über einen Link. Ein Agent, der es versucht, bekommt die Meldung „Zugriff auf diesen Pfad ist nicht erlaubt.“ (lokales Modell) bzw. „… ist geschützt (Git, Agent-Einstellungen oder Geheimnisse).“ (Claude-CLI). Die Datei wird nicht geschrieben; der Agent bekommt die Meldung zurück und kann weiterarbeiten.

**Printscreens:** keine. Dieser Abschnitt hat keine Oberfläche; die Wirkung zeigt sich nur in den Meldungen eines Agent-Laufs und im Verhalten von Commits und Merges.

**Agent-CLIs (Claude, Codex) und Deploy-Befehle** behalten ihre Umgebung. Nur `DEV_LOG_*` wird entfernt, weil sie ihre eigenen API-Schlüssel bzw. Hoster-Zugänge brauchen.

**Coverage-Messung, Bedingungen:**
- Testbefehle `npx tsx --test <Dateien>` oder `node --test …` werden direkt mit Abdeckung gemessen, ohne Skript und ohne Vorbereitung.
- Läuft der Test über ein `test`-Skript mit Vorbereitungsschritten, werden diese nur ausgeführt, wenn sie zur erlaubten Liste gehören (`npm run`, `npm ci`, `tsc`, `ng build`, `vite build`), und ohne Verkettung mit `&&`, `;`, Pipes, Umleitungen oder `$`. Sonst entfällt die Messung, und der Schritt nennt den Grund. Die Tests selbst laufen weiter.

**Testläufe mit eigenem Datenbank-Passwort:** Ein Testlauf, den du unter **Testläufe** anforderst, und der Komplettlauf (`npm run test:full`) funktionieren auch dann, wenn du in der `.env` ein eigenes `DEV_LOG_DB_PASSWORD` hast, zum Beispiel vom Einrichtungs-Assistenten erzeugt.
- Der Worker gibt diesen Befehlen nur `DEV_LOG_DATABASE_URL` mit, dazu das Admin-Ziel `E2E_ADMIN_DATABASE_URL` (Datenbank `postgres`, gleicher Zugang). Secret Key und alle anderen `DEV_LOG_*`-Werte fehlen dort.
- Startest du `test:full` oder den E2E-Webserver von Hand, lesen sie den Zugang aus `DEV_LOG_DB_USER` und `DEV_LOG_DB_PASSWORD` der `.env` (Port 5433).
- Das Passwort `devlog_local_dev` gilt nur noch, wenn die `.env` kein eigenes Passwort enthält. Dann warnt der Server.
- Ein Passwort mit Sonderzeichen wie `@`, `:` oder `/` funktioniert, weil die Adresse mit dem URL-Parser gebaut wird.
- Die übrigen Befehle (Chat-Assistent, Coverage) bekommen weiterhin nur die Allowlist ohne `DEV_LOG_*`.

---

### 5.5 Befehlsausgabe in Testläufen lesen

Dieser Abschnitt betrifft die Ausgabe, die ein Test- oder Befehlsschritt zurückgibt (Auftrags-Testlauf, Test-Gate, Komplettlauf). Eine Einstellung gibt es dafür nicht.

**Was gilt:**
- Jede Ausgabe ist auf **120 000 Zeichen** begrenzt. Bleibt sie darunter, steht sie vollständig da.
- Ist sie länger, bleiben der **Anfang (20 000 Zeichen)** und das **Ende (100 000 Zeichen)**. Dazwischen steht die Zeile `[… N Zeichen der Ausgabe ausgelassen …]`. Das Mittelstück wird schon während des Laufs verworfen.
- Das Ende bleibt, weil dort die Fehlerzusammenfassung und die Coverage-Zeilen des Tests stehen. Steht eine Fehlermeldung nur im gekürzten Mittelstück, ist sie in der Ausgabe nicht mehr zu sehen.
- Geheimnisse werden **vor dem Kürzen** geschwärzt. Ein Wert, der über eine Schnittkante reicht, erscheint deshalb nicht halb.
- Umlaute und Emojis bleiben auch dann richtig, wenn sie über eine Chunk-Grenze der Ausgabe laufen. Es wird nie mitten in ein Emoji geschnitten.
- Bei Claude-Schritten (`stream-json`) wird nur die Ausgabe von stdout als Ergebnis gelesen. Fehlermeldungen aus stderr landen in der Ausgabe, verfälschen aber nicht das Ergebnis.
- **Ohne Ergebnis-Ereignis gilt ein Claude-Schritt als fehlgeschlagen.** Das gilt auch bei Exit-Code 0. Die Meldung „Die Claude-CLI hat kein Ergebnis gemeldet (result-Ereignis fehlt) …“ steht am Ende der Ausgabe. Die Kosten sind dann nicht 0, der Schritt ist nur nicht bewertbar.
- Die Live-Ausgabe aktualisiert sich höchstens alle 500 ms. Bei sehr langen Läufen sieht man den lesbaren Text der letzten rund 120 000 Zeichen.

**Abhilfe, wenn die Coverage fehlt:** Die Zahlen stehen im Ende der Ausgabe. Fehlen sie dort, prüfe den Testbefehl gegen die Bedingungen in Abschnitt 5, Coverage-Messung.

**Printscreens:** Für diesen Abschnitt fehlen Bildschirmfotos. Sie erfordern eine laufende App mit Datenbank und Browser. Der Text oben beschreibt, was du siehst. Die Beschriftungen müssen gegen die laufende Oberfläche geprüft werden, bevor das Handbuch veröffentlicht wird.

---

## 6. Anmeldung, Sitzungen und Zwei-Faktor (Einstellungen → Sicherheit)

Dieser Abschnitt betrifft den Bereich **Einstellungen → Sicherheit**. Er gilt für jeden Benutzer, auch für den Systemadministrator aus der `.env`.

**Printscreens:** keine. Die Beschreibung nennt die Beschriftungen, wie sie im Bereich stehen. Ein Browserlauf für Aufnahmen ist nicht erfolgt.

### 6.1 Was sich geändert hat

- **Sitzung ist an das Passwort gebunden.** Jede Anmeldung merkt sich eine Version der Zugangsdaten. Ändert sich das Passwort, passt die alte Sitzung nicht mehr und gilt als abgemeldet.
  - Benutzer: Ein neues Passwort beendet alle Sitzungen dieses Benutzers.
  - Systemadministrator: Ein neues `DEV_LOG_PASSWORD` in der `.env` beendet alle Sitzungen beim nächsten Start.
- **Einmalige Abmeldung nach dem Update.** Sitzungen von vor dieser Änderung haben keine Bindung und gelten nicht mehr. Alle Benutzer melden sich einmal neu an. Das ist gewollt.
- **Aufräumen:** Abgelaufene und ungebundene Sitzungen löscht der Dienst beim Start und danach stündlich. Gültige Sitzungen bleiben.
- **Zwei-Faktor-Anmeldung (TOTP) ist abgesichert:**
  - Einrichten, Ausschalten und jeder Schritt zum Ersetzen verlangen das **aktuelle Passwort**. Ohne Passwort passiert nichts, und es wird nichts gespeichert.
  - Ist die Zwei-Faktor-Anmeldung schon aktiv, verlangt das Ausschalten zusätzlich einen **aktuellen Code** aus der App. Ein gestohlenes Cookie reicht damit nicht mehr, um den zweiten Faktor zu ersetzen oder abzuschalten.
  - Die Geheimnisse liegen verschlüsselt in der Datenbank, nicht mehr im Klartext.

### 6.2 Bedienung

| Aktion | Wo | Was du eingibst | Ergebnis |
| --- | --- | --- | --- |
| Zwei-Faktor einrichten | Sicherheit → „Zwei-Faktor-Anmeldung“, Feld „Aktuelles Passwort“, Schaltfläche „Einrichten“ | Passwort | QR-Code und Schlüssel erscheinen. Danach den 6-stelligen Code aus der App unter „Code aus der App“ eingeben und „Bestätigen“ drücken. |
| Ausschalten | Sicherheit → „Zwei-Faktor-Anmeldung“ (nur wenn „Aktiv“), Felder „Aktuelles Passwort“ und „Code zum Ausschalten“, Schaltfläche „Ausschalten“ | Passwort und aktueller Code | Zwei-Faktor ist aus. |
| Ersetzen | Erst „Ausschalten“, dann „Einrichten“ | wie oben | Neuer Schlüssel. Der alte Code funktioniert danach nicht mehr. |
| Andere Geräte abmelden | Sicherheit → „Andere Geräte abmelden“ | – | Alle anderen Sitzungen dieses Kontos enden. Die aktuelle bleibt. |
| Abmelden | Sicherheit → „Abmelden“ (nur bei Anmeldung mit Login) | – | Die aktuelle Sitzung endet. |

**Bedingungen und Grenzen:**

- Die Zwei-Faktor-Anmeldung braucht den Schlüssel `DEV_LOG_SECRET_KEY` in der `.env`. Ohne ihn lässt sie sich nicht einrichten, und der Dienst startet nicht, sobald schon Geheimnisse gespeichert sind. Die Meldung nennt keine Interna.
- Der Schlüssel muss gesichert sein (Passwort-Manager). Geht er verloren, lassen sich die gespeicherten Geheimnisse nicht mehr lesen. Siehe `installation.md` für die Wiederherstellung.
- Falsches Passwort und falscher Code werden nicht getrennt gemeldet. Ist die Zwei-Faktor-Anmeldung aktiv, lautet die Meldung „Passwort oder Code stimmen nicht.“, damit niemand aus ihr ableiten kann, was stimmt.
- Die Anmeldung bremst nach Fehlversuchen, sie sperrt nicht hart. Nach 10 Fehlversuchen für denselben Benutzernamen von derselben Adresse wartet man zuerst 1 Minute. Jeder weitere Fehlversuch verdoppelt die Wartezeit, höchstens sind es 15 Minuten. Die Meldung „Zu viele Fehlversuche …“ nennt die Wartezeit. Gebremst wird nur dieses Konto von dieser Adresse aus, andere Benutzer und Geräte bleiben frei. Ausnahme: Kommen von einer Adresse mehr als 300 Fehlversuche in einer Minute, wird diese Adresse für alle Namen gebremst. Nach dem richtigen Passwort nach Ablauf der Wartezeit ist die Anmeldung wieder frei.
- Hinter einem Proxy (Caddy oder nginx) setzt die Administration `DEV_LOG_TRUST_PROXY` auf die Adresse des Proxys (Standard in Compose: `uniquelocal`). Ohne das sehen alle externen Geräte dieselbe Adresse, und die Bremse trifft alle gemeinsam. Einzelheiten stehen in `installation.md`.
- Bei Anmeldung mit `DEV_LOG_AUTH=off` gibt es in diesem Bereich nichts einzustellen.

### 6.3 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Nach dem Update überall abgemeldet | Gewollt. Sitzungen von vor der Passwort-Bindung gelten nicht mehr. Einmal neu anmelden. |
| Nach neuem `DEV_LOG_PASSWORD` abgemeldet | Gewollt. Eine Passwortrotation beendet alle Sitzungen des Systemadministrators. Mit dem neuen Passwort neu anmelden. |
| Dienst startet nicht, nachdem Zwei-Faktor aktiv war | `DEV_LOG_SECRET_KEY` fehlt in der `.env`. Den gesicherten Schlüssel eintragen und den Dienst neu starten. |
| „Zwei-Faktor lässt sich gerade nicht einrichten. Bitte die Administration informieren.“ | Der Schlüssel fehlt, deshalb speichert AIdeation kein Geheimnis. Die Administration setzt `DEV_LOG_SECRET_KEY`, danach erneut einrichten. |
| „Der Code stimmt nicht.“ beim Bestätigen | Der Code ist abgelaufen oder stammt von einer anderen Einrichtung. Den aktuellen Code aus der App eingeben. Stimmt die Uhr des Handys nicht, schlagen Codes fehl. |
| „Zu viele Fehlversuche. Bitte in … erneut versuchen.“ | Die Wartezeit läuft ab dem letzten Fehlversuch. Die Meldung nennt sie in Minuten, höchstens 15. Bis dahin hilft kein neuer Versuch. Andere Benutzernamen und andere Geräte bleiben frei, außer bei mehr als 300 Fehlversuchen pro Minute von einer Adresse. |
| „Passwort oder Code stimmen nicht.“ beim Ausschalten | Das Passwort oder der Code ist falsch. Den aktuellen Code aus der App eingeben. Die Meldung ist absichtlich dieselbe für beides. |
| Code verloren, Zugang nicht mehr möglich | Die Administration setzt die Zwei-Faktor-Anmeldung zurück. Das Vorgehen steht in `README.md`, Abschnitt Sicherheit. |

---

## 7. Repo-Dokumentation und Bild-Anhänge (Symlinks)

Dieser Abschnitt betrifft die Seite **Dokumentation** (Einträge mit der Art „Repo“, also `README.md` und `docs/*.md` des Projekts) und die Bilder, die CLI-Agents zu einer Idee oder einem Bug bekommen. AIdeation folgt dabei **keinen Symlinks** mehr. Vorher konnte ein Link wie `docs/x.md -> ~/.ssh/id_rsa` den Inhalt einer fremden Datei in die Dokumentation holen, und der war für alle Projektmitglieder lesbar.

> **Screenshots:** Für diesen Abschnitt fehlt noch ein Bild der Seite Dokumentation mit einem übersprungenen Eintrag. Es wurde nicht aufgenommen, weil dafür App, Datenbank und Browser laufen müssen.

### 7.1 Repo-Doku-Sync: wann eine Datei übernommen wird

Der Sync läuft mit dem Projektlauf. Er liest nur Dateien, die direkt im Projektordner liegen.

| Bedingung | Ergebnis |
| --- | --- |
| Normale Datei, Größe höchstens 200 000 Bytes | Wird übernommen, der Titel ist der Pfad (z. B. `docs/laufzeit.md`). |
| Datei ist ein Symlink | Wird übersprungen. Ein Link auf eine Datei außerhalb des Projekts wird nie gelesen. |
| Ordner `docs` oder ein Unterordner ist ein Symlink | Alle Dateien darin werden übersprungen. |
| Datei hat mehrere Verweise (Hardlink) | Wird übersprungen. |
| Link ins Leere oder fehlende Datei | Wird übersprungen, der Sync bricht nicht ab. |
| Datei größer als 200 000 Bytes | Wird übersprungen. |
| Datei wird während des Lesens ausgetauscht | Wird übersprungen. |

**Was das für dich bedeutet:** Ein Projekt, das bewusst Symlinks in `docs/` nutzt, verliert diese Einträge in der Dokumentation. Abhilfe: die Datei als echte Kopie in `docs/` ablegen und die Kopie pflegen.

### 7.2 Bild-Anhänge für CLI-Agents

Bilder einer Idee oder eines Bugs werden vor dem Lauf nach `.dev-log/attachments/<ID>/` geschrieben. Die Dateien heißen `1-<Name>`, `2-<Name>` usw. Ungültige Auftrags-IDs bekommen keine Bilder.

| Bedingung | Ergebnis |
| --- | --- |
| `.dev-log` oder `.dev-log/attachments` ist ein Symlink | Nichts wird gelöscht und nichts geschrieben. Der Agent bekommt keine Bilder, der Lauf geht ohne sie weiter. |
| Der Auftragsordner `<ID>` ist ein Symlink | Nur der Link wird entfernt, nie sein Ziel. Die Bilder werden danach neu angelegt. |
| Ein Zwischenordner fehlt | Er wird einzeln angelegt, nicht rekursiv, damit kein Link durchlaufen wird. |
| Der Ordner `<ID>` lässt sich nicht leeren, weil ein Teil des Pfads ein Link ist | Dann wird gar nichts geschrieben, und der Agent bekommt keine Bilder. Den Link durch einen echten Ordner ersetzen. |

### 7.3 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Eintrag fehlt in „Dokumentation“ | Im Projekt nachsehen: `ls -l docs/` zeigt Symlinks mit `l` am Anfang, Hardlinks mit einer Zahl größer als 1 in der zweiten Spalte. Durch eine echte Datei ersetzen. |
| Agent bekommt keine Bilder | `.dev-log` oder `.dev-log/attachments` im Projekt ist ein Link. Den Link durch einen echten Ordner ersetzen und den Lauf erneut starten. |

### 7.4 Grenzen

- **Windows:** Junctions werden nicht als Symlink erkannt. Dort greift der Schutz nur eingeschränkt.
- **Kurzes Zeitfenster:** Ein Link, der genau zwischen der Prüfung eines Elternordners und dem Schreiben oder Löschen eingesetzt wird, ist nicht abgefangen. Dafür ist ein eigener Folgeauftrag vorgesehen.
- **Lesen:** Für Bilder und Dateien des Projekts, die andere Agents über Werkzeuge lesen (Favicon, Visionär), gilt diese Regel noch nicht. Dort ist die Umstellung ein eigener Auftrag.

---

## 6a. Datenbank-Abfragen (`run_sql`) für Entwickler und Chat-Assistenten

Der Entwickler-Agent und der Chat-Assistent können SQL gegen die **Projekt-Datenbank** ausführen. Das Werkzeug heißt `run_sql`. Du siehst das Ergebnis im Verlauf des Laufs bzw. im Chat, nicht als eigenen Bildschirm.

**Voraussetzung:** In den Projekteinstellungen ist eine Projekt-Datenbank hinterlegt. Die Adresse wird nie im Frontend angezeigt. Ohne sie gibt es keine Abfragen.

**Was erlaubt ist**

- Eine Anweisung pro Aufruf. Mehrere Anweisungen in einem Aufruf werden abgelehnt.
- Lesen und Daten ändern (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) sowie additive DDL (`CREATE TABLE`, `ALTER TABLE … ADD`).
- `UPDATE` und `DELETE` nur mit echter `WHERE`-Bedingung. Abgelehnt werden u. a. `WHERE true`, `WHERE 1=1`, `WHERE 2>1` und `WHERE id IS NOT NULL`.

**Was gesperrt ist**

- Die AIdeation-Datenbank selbst. Ist die hinterlegte Adresse diese Datenbank, wird sie nicht verwendet.
- Transaktions- und Sitzungsbefehle am Anfang einer Anweisung (`BEGIN`, `COMMIT`, `ROLLBACK`, `SET`, `RESET` …). Der Lauf verwaltet die Transaktion selbst.
- `DROP` auf Datenbank, Rolle, Erweiterung, Schema, Tabelle, Sicht, Sequenz oder Typ, `TRUNCATE`, `ALTER … DROP`, `ALTER SYSTEM`, `ALTER`/`CREATE` von Datenbank, Rolle oder Erweiterung.
- `DO`-Blöcke, `EXECUTE`, eigene Funktionen, Prozeduren und Trigger, `GRANT`/`REVOKE`, `COPY`, Rollenwechsel.
- Server- und Dateifunktionen (z. B. `pg_read_file`, `lo_import`, `pg_terminate_backend`, `dblink`).
- Unicode-Escapes `U&'…'` und `U&"…"`, offene Strings oder Kommentare.

**Grenzen beim Ergebnis**

| Grenze | Wert | Was passiert |
| --- | --- | --- |
| Zeilen | höchstens 50 | Die 51. Zeile bricht die Abfrage ab. Die Transaktion wird zurückgerollt, nichts gespeichert. Die Meldung bittet, mit `WHERE` oder `LIMIT` einzugrenzen. |
| Ergebnisgröße | höchstens 1 MB (als JSON gemessen) | Gleiches Verhalten wie bei den Zeilen. |
| Zelle | höchstens 500 Zeichen in der Ausgabe | Die Zelle wird gekürzt und mit der Länge markiert. `bytea` wird als `\x…` angezeigt. |

**Zeitlimits**

- Die Datenbank bricht eine Anweisung nach 15 s ab, ein Warten auf eine Sperre nach 5 s und eine offene Transaktion ohne Aktivität nach 20 s.
- Der Worker wartet höchstens 20 s auf die Abfrage. Danach wird sie abgebrochen (`pg_cancel_backend` über eine zweite Verbindung) und nichts gespeichert. Die Meldung lautet „SQL-Zeitlimit …“.

**Wann eine Abfrage abgebrochen wird:** Wird der Agent beendet (Stopp, Zeitlimit des Laufs, Herunterfahren des Workers), endet auch die laufende Abfrage. Die Meldung lautet „SQL abgebrochen: Der Agent wurde beendet, nichts gespeichert.“

**Erfolg:** Eine Meldung „OK“ oder „UPDATE …“ mit Zeilenzahl erscheint nur, wenn der `COMMIT` bestätigt ist. Fehlt die offene Transaktion vor dem `COMMIT` oder hat der Server zurückgerollt, steht dort „SQL-Fehler … nichts gespeichert“ bzw. „das Ergebnis ist nicht bestätigt“. Ein Fehler wird also nicht als Erfolg gemeldet.

**Typische Meldungen und was zu tun ist**

| Meldung | Ursache und was zu tun ist |
| --- | --- |
| „Nicht erlaubt: mehrere Anweisungen …“ | Die Abfrage in einzelne Aufrufe aufteilen. |
| „UPDATE und DELETE brauchen eine echte WHERE-Bedingung …“ | Eine Bedingung angeben, die nur die betroffenen Zeilen trifft. |
| „Ergebnis zu groß: mehr als 50 Zeilen …“ | Mit `WHERE` oder `LIMIT` eingrenzen oder Spalten weglassen. Bei `UPDATE … RETURNING` gilt dasselbe: Die Änderung wird dann nicht gespeichert. |
| „SQL-Zeitlimit: …“ | Die Abfrage ist zu langsam. Index prüfen oder Umfang verringern. |
| „Der hinterlegte Datenbank-Zugang zeigt auf die AIdeation-Datenbank …“ | In den Projekteinstellungen die richtige Projekt-Datenbank eintragen. |

**Wichtig:** `run_sql` ist ein Schutz gegen Fehlgriffe, keine Sicherheitsgrenze. Die eigentliche Grenze ist ein Datenbank-Benutzer des Projekts mit eingeschränkten Rechten (lesend, wo möglich). Den Benutzer richtest du in der Projekt-Datenbank ein, nicht in AIdeation.

**Bilder:** Für diesen Abschnitt gibt es noch keine Printscreens. Dafür müssten App, Projekt-Datenbank und ein Agent-Lauf mit `run_sql` laufen. Platzhalter: `[Bild 4] Verlauf eines Laufs mit einer abgelehnten Abfrage` und `[Bild 5] Ergebnisausgabe mit gekürzter Zelle`.

---

## 8. Ein Arbeitsordner, ein Auftrag (Sperre und Chat)

Ein Projekt hat einen Arbeitsordner, in dem Agents Dateien ändern, committen und den Branch wechseln. Damit nicht zwei Agents gleichzeitig darin arbeiten, gilt jetzt eine Sperre. Du musst dafür nichts einstellen. Der Ablauf ist aber anders als früher, und das zeigt sich im Dashboard und im Chat.

### 8.1 Wer schreibt, wer liest

| Agent | Ordner | Bedingung |
| --- | --- | --- |
| Entwickler, Tester, Dokumentierer (Benutzerhandbuch), Autofix | schreibend, hält die Sperre | Läuft im Auftrag. Die Sperre gilt vom ersten schreibenden Schritt bis zum Ende des Auftrags. |
| Chat-Assistent | schreibend, wenn der Ordner frei ist | Ist der Ordner belegt, antwortet er nur lesend. |
| Auftragsautor, Bug-Wächter, Visionär, Analyse, Abnahme, Sprint-Kommentar | nur lesend (Standard) | Sie dürfen nicht schreiben. Ein Agent, der schreiben soll, muss den Ordner selbst halten. |
| Vor-dem-Sprint-Agents | nur lesend | Nur Planung und Prüfung. |

Die Angaben stammen aus `src/agent/chat.ts`, `src/agent/requirements.ts` (Standard `readOnly = true`) und `src/runner/runner.ts` (`TREE_ROLES`).

### 8.2 Chat-Assistent: schreibend oder nur lesend

- **Ordner frei:** Der Assistent darf Dateien ändern und Befehle ausführen. Er hält den Ordner bis zum Ende seiner Antwort.
- **Ordner belegt:** Ein Auftrag, ein Testlauf oder ein anderer Worker nutzt den Ordner gerade. Der Assistent antwortet nur lesend und sagt dir das im Chat. Stelle die Frage nach dem Lauf erneut.
- **Warum:** Schreibt der Assistent während eines Entwickler-Schritts, landen seine Änderungen im Commit des Auftrags. Ein `git checkout main` durch den Assistenten hätte die Änderungen des Entwicklers auf `main` committet. Das ist mit der Sperre nicht mehr möglich.

`[Bild 6] Chat-Antwort, wenn der Arbeitsordner belegt ist (nur lesend)`

### 8.3 Wartende Läufe

- Ist der Ordner belegt, wartet der Lauf. Im Log steht einmal „wartet auf Arbeitsordner“.
- Das ist **kein Fehler**. Autofix startet dadurch keinen neuen Versuch.
- Der Lauf startet, sobald der Ordner frei ist. Du musst nichts tun.
- **Bekannte Lücke:** Der Status „wartet auf Arbeitsordner“ erscheint noch nicht in der Oberfläche. Schau dafür im Log des Laufs nach.

`[Bild 7] Log eines wartenden Laufs mit dem Hinweis „wartet auf Arbeitsordner“`

### 8.4 Ein Ordner, ein Auftrag

- Zwei Projekte mit demselben Repository oder demselben Ordner (auch über einen Symlink) laufen nicht gleichzeitig. Der zweite wartet.
- Die Sperre gilt über Prozessgrenzen hinweg, also auch für einen zweiten Worker (z. B. Host und Container). Dafür sorgt eine Sperre in der Datenbank. Stürzt ein Worker ab, gibt Postgres die Sperre selbst frei.
- **Bedingung:** Die Sperre schützt nur, wenn Host und Container denselben Ordner unter **demselben Pfad** sehen. Zeigen sie über verschiedene Pfade auf denselben Ordner, entstehen zwei Schlüssel und die Sperre wirkt nicht. Prüfe das bei einem Container-Betrieb.
- **Ohne Datenbank** (z. B. in Tests) gilt die Sperre nur innerhalb des Prozesses.

### 8.5 Was du beachten solltest

- Ein eigener Agent, der Dateien ändern soll, braucht eine Freigabe über die Sperre. Sonst läuft er nur lesend.
- Eigene Befehle im Projekt, die den Branch wechseln, können die Sperre umgehen, wenn sie außerhalb von AIdeation laufen. Lass während eines Laufs keine manuellen Checkouts im Arbeitsordner machen.
- `verifyAcceptance` (Abnahme) läuft weiterhin ohne Shell. Es kann keine Befehle ausführen.

### 8.6 Kompletter Test bei offenen Änderungen im Arbeitsordner

Der Knopf **Aktionen → Kompletter Test** prüft immer den Stand von `main`, nicht den halbfertigen Stand eines Auftrags. Dafür checkt AIdeation im Agent-Worktree `main` losgelöst aus. Hat der Worktree offene Änderungen, startet der Test nicht mehr.

Typischer Fall: Ein Auftrag wartet nach dem Nutzungslimit mit Zwischenstand auf seinem Branch (`auftrag/…`). Kein Lauf ist aktiv, deshalb wäre der Komplette Test sonst gestartet. Bisher lief er dann gegen den halbfertigen Code, und rote Ergebnisse wurden als neue Bugs angelegt. Das ist behoben.

| Zustand des Arbeitsordners | Ergebnis |
| --- | --- |
| Offene Änderungen an versionierten Dateien | Kein Testbefehl, kein Agent, keine Bugs. Die Anforderung steht auf **fehlgeschlagen** mit dem Grund „Offene Änderungen im Agent-Worktree (wartender Auftrag?) – Test auf main nicht möglich“. |
| `git status` schlägt fehl | Wie oben, Grund „git status im Agent-Worktree fehlgeschlagen – Test auf main nicht möglich: …“ mit den letzten Zeilen der Git-Ausgabe. |
| Sauber, Worktree schon auf `main` losgelöst | Test läuft wie bisher. |
| Kein verknüpfter Worktree (Hauptordner) | Test läuft wie bisher. |
| Nur nicht versionierte Dateien | Test läuft. Nicht versionierte Dateien zählen nicht als offene Änderung. |

**Bedingungen:**

- Die Anforderung wird **nicht** automatisch wieder eingereiht. Sonst würde sie sofort wieder beansprucht und in einer Schleife laufen.
- Den Komplettlauf löst du neu aus, wenn der wartende Auftrag abgeschlossen oder verworfen ist und der Arbeitsordner sauber ist.
- Ein fehlgeschlagener Checkout auf `main` bei sauberem Stand bricht den Test weiterhin nicht ab. Das ist bewusst so.

**Printscreens:** keine. Der Fall tritt nur auf, wenn ein Auftrag im Arbeitsordner wartet. Ein Bildschirmfoto braucht laufenden Docker-Stack und einen solchen Zustand. Platzhalter: `[Bild 11] Testläufe mit fehlgeschlagener Anforderung „Offene Änderungen im Agent-Worktree …“`.

### 8.7 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Kompletter Test ist „fehlgeschlagen“ mit „Offene Änderungen im Agent-Worktree“ | Ein Auftrag wartet mit Zwischenstand. Auftrag abschließen oder verwerfen, dann den Komplettlauf neu auslösen. |
| „git status im Agent-Worktree fehlgeschlagen“ | Der Arbeitsordner ist beschädigt oder gesperrt. Den Grund in der Meldung prüfen und den Ordner im Terminal mit `git status` kontrollieren. |
| Komplettlauf meldet rote Tests, obwohl `main` gesund ist | Alte Fassung. Nach dem Update die Anforderung neu auslösen. Bereits angelegte Bugs aus einem früheren Lauf auf halbfertigem Stand bitte prüfen und schließen. |

---

## 9. Board: offene Aufträge und Ideen immer vollständig

Das Board (Sprint, Backlog, Aktionen und Ideen) zeigt jetzt alle **offenen** Einträge des aktiven Projekts. Früher wurden nur die 200 neuesten Einträge geladen, unabhängig vom Status. Bei mehr als 200 Aufträgen fehlten daher ältere geplante, blockierte oder laufende Aufträge. Die Sprintplanung hat sie trotzdem vorgeschlagen, und du konntest sie nicht sehen oder bearbeiten. Das ist behoben. Du musst dafür nichts einstellen.

### 9.1 Was geladen wird

| Art | Wird immer vollständig geladen | Wird begrenzt auf die 200 neuesten |
|-----|-------------------------------|-------------------------------------|
| Aufträge | Status `backlog`, `planned`, `in_progress`, `blocked`, `approval` und alle ohne Status | Status `done` und `rejected` |
| Ideen | Status `idea`, `considering`, `review`, `requested`, `drafting` und alle ohne Status | Status `accepted` und `rejected` |

- „Offen“ heißt: alles, was **nicht** im Status „abgeschlossen“ steht. Ein Eintrag ohne Status gilt als offen und erscheint.
- Die Sortierung bleibt wie bisher: neueste zuerst (nach Anlagedatum).
- Jeder Eintrag erscheint nur einmal.
- Was die Sprintplanung vorschlagen kann, siehst du jetzt auch im Board.

### 9.2 Herkunftsfilter bei Ideen

- Der Filter „Herkunft“ (z. B. `visionary`) gilt weiterhin für Ideen.
- Er wirkt auf offene und auf die 200 neuesten abgeschlossenen Ideen gleichermaßen.
- Ein unbekannter Filterwert zeigt alle Ideen, wie bisher.

### 9.3 Bedingungen und Grenzen

- Die Grenze von 200 gilt nur für erledigte, abgelehnte und angenommene Einträge. Ältere abgeschlossene Einträge erscheinen nicht im Board, bleiben aber in der Datenbank erhalten.
- Bei sehr vielen offenen Einträgen wird die Antwort entsprechend größer. Eine Seitenaufteilung (Paginierung) gibt es noch nicht.
- Ein neuer Endstatus muss in die Liste der abgeschlossenen Status aufgenommen werden (`src/core/status.ts`). Sonst gilt er als offen und bleibt dauerhaft sichtbar.

### 9.4 Fehlerbehebung

| Problem | Ursache und Lösung |
|---------|--------------------|
| Ein älterer Auftrag fehlt noch | Prüfe den Status. Nur erledigte und abgelehnte Aufträge sind auf die 200 neuesten begrenzt. Offene erscheinen immer. |
| Ein Auftrag mit Status `done` ist nicht zu sehen | Gewollt, wenn er zu den älteren erledigten gehört. Er bleibt in der Datenbank. |
| Die Ideenliste ist nach einem Filter leer | Der Herkunftsfilter schränkt ein. Stelle den Filter zurück auf alle Herkünfte. |

**Hinweis:** Für diesen Abschnitt liegen keine Printscreens vor. Die Board-Oberfläche lässt sich nur mit laufendem Docker-Stack und Anmeldung aufnehmen. Printscreens sollten nachgereicht werden, wenn der Stack verfügbar ist. Bilder wurden nicht erfunden.

## 10. Bugs einem Sprint zuordnen

Du kannst einen Bug einem Sprint zuordnen. Das geht im Anlegen-Formular, in der Bug-Zeile und unter „Bug bearbeiten“. Ordnest du einen Bug zu, legt AIdeation einen Auftrag „Bug: …“ im Sprint an. Der Auftrag läuft nur, wenn der Sprint läuft.

### 10.1 Welche Sprints zur Auswahl stehen

- **Zur Auswahl:** nur geplante und aktive Sprints.
- **Nicht zur Auswahl:** abgebrochene, in Prüfung befindliche und abgeschlossene Sprints.
- **Ausnahme:** Ist der Bug schon einem solchen Sprint zugeordnet, bleibt dieser Sprint in der Auswahl sichtbar. So verlierst du die Zuordnung nicht, wenn du nur Titel oder Status änderst.

### 10.2 Was die Schnittstelle prüft

- Eine Zuordnung zu einem abgebrochenen, in Prüfung befindlichen oder abgeschlossenen Sprint wird mit **409** abgelehnt. Es wird weder der Bug gespeichert noch ein Auftrag angelegt.
- Die Prüfung greift nur, wenn sich die Sprint-Zuordnung ändert. Ein Bug, der schon an einem solchen Sprint hängt, bleibt bei anderen Änderungen bearbeitbar.
- Das Entfernen der Zuordnung ist immer erlaubt.
- Der Sprint muss zum selben Projekt gehören wie der Bug. Sonst kommt **400**.

### 10.3 Fehlerbehebung

| Problem | Ursache und Lösung |
|---------|--------------------|
| Ein Bug ist einem abgebrochenen oder abgeschlossenen Sprint zugeordnet, und sein Auftrag läuft nie | Ältere Zuordnungen werden nicht automatisch umgehängt. Ordne den Bug einem geplanten oder aktiven Sprint zu. Sonst bleibt sein Auftrag liegen. |
| Der gewünschte Sprint fehlt in der Auswahl | Der Sprint ist abgebrochen, in Prüfung oder abgeschlossen. Wähle einen geplanten oder aktiven Sprint. |
| Speichern schlägt mit 409 fehl | Der Sprint ist nicht mehr zuordenbar. Wähle einen geplanten oder aktiven Sprint. |

**Hinweis:** Für diesen Abschnitt liegen keine Printscreens vor. Die Bug-Seite lässt sich nur mit laufendem Docker-Stack und Anmeldung aufnehmen. Printscreens sollten nachgereicht werden, wenn der Stack verfügbar ist.

---

## 11. Chat mit gewähltem Agent: welche Rechte gelten

Im Chat kannst du einen bestimmten Agent ansprechen. Dann bekommt die Antwort die Rechte **dieses Agents**, nicht pauschal die des Assistenten. Das gilt auch dann, wenn der Befehl des Agents `--dangerously-skip-permissions` enthält.

### 11.1 Agent wählen

- Tippe im Chat-Feld `@` und wähle den Agent aus der Liste.
- Der gewählte Agent erscheint als Chip mit dem Namen. Mit dem Kreuz (`×`) auf dem Chip entfernst du die Auswahl.
- Ohne Auswahl antwortet der Chat-Assistent mit seinen eigenen Rechten.

### 11.2 Welche Rechte gelten

| Rolle des gewählten Agents | Rechte im Chat | Was der Befehl mit `--dangerously-skip-permissions` bewirkt |
| --- | --- | --- |
| Assistent | Vollzugriff: Dateien und Befehle wie beim Chat-Assistenten | Der Lauf startet ohne Wächter. Geheimnisse bleiben trotzdem gesperrt (Abschnitt 1.4). |
| Entwickler, Tester, Reviewer, Dokumentierer und andere Rollen | Wächter ist aktiv (Hook, Ordnergrenze, Freigaben des Agents) | Wirkungslos. Der Wächter bleibt aktiv. |
| Visionär, Vor-dem-Sprint-Agents | Nur lesen: keine Datei-Werkzeuge, keine Shell | Wirkungslos. |
| Ohne Rolle oder unbekannte Rolle | Nur lesen | Wirkungslos. |

**Bedingungen:**

- Die Rolle bestimmt die Rechte, nicht der Name des Agents. Einen Agent „Assistent“ nennen, ohne die Rolle Assistent, bringt keinen Vollzugriff.
- Eine fehlende Rolle führt zu „nur lesen“, nie zu Vollzugriff.
- Die Befehle und Freigaben des Agents gelten im Chat weiterhin: Die Ordnergrenze, die Freigaben und die Liste der Dateibefehle (Abschnitt 3) bleiben bestehen.
- Die Ordnersperre aus Abschnitt 8 gilt auch hier. Ist der Arbeitsordner belegt, antwortet der Agent nur lesend.
- Die Rolle eines Agents ändert nur die Administration. Ändert sich die Rolle, gelten die Rechte beim nächsten Chat-Befehl.

**Bekannte Lücke:** Bei einem lokalen Modell (Ollama) hängt das Verwalten von Diensten weiter an der Rolle Assistent. Ein gewählter Entwickler-Agent darf dort also Dienste verwalten. Dafür ist ein eigener Auftrag vorgesehen.

**Printscreens:** keine. Die Chat-Seite lässt sich nur mit laufendem Docker-Stack und Anmeldung aufnehmen. Die Beschriftungen oben stammen aus dem Code (`chat-composer.component.ts`, `agent-tasks.component.html`). Sie sollten am laufenden System geprüft werden.

### 11.3 Fehlerbehebung

| Problem | Ursache und Lösung |
| --- | --- |
| Der Agent im Chat darf keine Dateien ändern | Seine Rolle ist Visionär, Vor-dem-Sprint oder keine Rolle. Das ist gewollt. Schreiben darf nur ein Agent mit schreibender Rolle, etwa Entwickler. Die Rolle ändert die Administration. |
| Der Befehl des Agents hat `--dangerously-skip-permissions`, der Chat fragt aber nach Freigaben | Gewollt. Vollzugriff gibt es nur für die Rolle Assistent. |
| Der Agent meldet „Arbeitsordner belegt“ oder antwortet nur lesend | Ein Auftrag oder Testlauf hält den Ordner. Stelle die Frage nach dem Lauf erneut (Abschnitt 8.2). |
| Im Chat ist kein Agent auswählbar | Der Agent gehört zu einem anderen Projekt. Prüfe, ob das richtige Projekt aktiv ist. |

---

## 12. Token-Limits je Agent-Rolle (nur API)

Zusätzlich zum Projektbudget (Einstellungen → Budget) kannst du je **Agent-Rolle** und Zeitraum ein Token-Limit setzen. Ein Entwickler-Agent kann so ein Tageslimit haben, ohne dass der Tester, Reviewer oder Dokumentierer davon betroffen sind. Das Projektlimit bleibt wie bisher. Die Rollen-Limits kommen dazu und ersetzen es nicht.

**Printscreens:** keine. Das Feature hat noch keine Oberfläche; Einstellungen, Dashboard und Statistik folgen in einem eigenen Auftrag. Die Beispiele unten zeigen Anfrage und Antwort der API in der Form, die der Code erzeugt. Sie wurden nicht gegen ein laufendes System geprüft.

### 12.1 Was du einstellen kannst

- **Rollen:** `author`, `developer`, `tester`, `reviewer`, `documenter`, `bug_reviewer`, `manual_writer`, `user_manual_writer`. Die Rolle `custom` hat kein Limit, weil sie keiner festen Aufgabe entspricht.
- **Zeiträume:** `day` (heute, Tageswechsel nach `DEV_LOG_TIMEZONE`), `sprint` (aktiver Sprint) und `order` (ein einzelner Auftrag).
- **Limit:** eine positive Zahl in Tokens oder `null`. `null` entfernt das Limit. Eine fehlende Zeile bedeutet **keine Grenze**: Für diese Rolle und diesen Zeitraum prüft der Worker nichts.
- **Wer:** Lesen ist für angemeldete Benutzer mit Projektzugriff vorgesehen. Ändern darf nur die Rolle **admin**. Ohne sie antwortet die API mit 403 und speichert nichts.

### 12.2 Endpunkte

**Lesen:** `GET /api/projects/:slug/budget/roles`

Die Antwort enthält je Rolle und Zeitraum den Grenzwert und den Verbrauch. Beispiel (Werte erfunden):

```json
{
  "warnPercent": 80,
  "sprintId": "sprint-23",
  "roles": [
    {
      "role": "developer",
      "limits": {
        "day": { "maxTokens": 500000, "spend": { "tokens": 420000, "costUsd": 3.1 }, "percent": 84 },
        "sprint": { "maxTokens": null, "spend": { "tokens": 1900000, "costUsd": 14.2 }, "percent": null },
        "order": { "maxTokens": null, "spend": null, "percent": null }
      }
    }
  ]
}
```

- `spend` ist der Verbrauch heute bzw. im aktiven Sprint. Beim Auftragslimit ist er `null`, weil der Verbrauch am einzelnen Auftrag hängt.
- `percent` ist `null`, wenn kein Limit gesetzt ist oder kein Verbrauch ermittelt wird.
- Ohne aktiven Sprint ist `sprintId` `null`.

**Ändern:** `PUT /api/projects/:slug/budget/roles/:role` (nur admin)

Der Body enthält die Zeiträume, die du ändern willst. Ein fehlender Zeitraum bleibt unverändert.

```json
{ "day": { "maxTokens": 500000 }, "sprint": null }
```

- `{ "maxTokens": 500000 }` setzt die Grenze, `null` oder `{ "maxTokens": null }` entfernt sie.
- Die Antwort hat dasselbe Format wie das GET.
- Nach dem Speichern gibt der Worker wegen Budget blockierte Aufträge sofort frei, wenn ihr Limit wieder reicht.

### 12.3 Fehlermeldungen

| Eingabe | Antwort | Meldung (Auszug) |
|---------|---------|------------------|
| Rolle unbekannt, z. B. `custom`, `foo`, `admin` | 400 | „Unbekannte Agent-Rolle „foo“: erlaubt sind author, developer, …“ |
| Zeitraum unbekannt, z. B. `week` | 400 | „Unbekannter Zeitraum „week“: erlaubt sind day, sprint und order.“ |
| Grenze keine positive Zahl, z. B. `-5` oder `"abc"` | 400 | „day: maxTokens muss eine positive Zahl sein (oder null für unbegrenzt).“ |
| Body ohne Zeitraum, z. B. `{}` | 400 | „Mindestens einen Zeitraum (day, sprint oder order) angeben.“ |
| Kein admin | 403 | Zugriff verweigert |
| Projekt existiert nicht | 404 | „Projekt nicht gefunden.“ |

Bei 400 wird nichts gespeichert, auch nicht für die anderen Zeiträume im Body.

### 12.4 Was der Worker damit macht

- **Prüfung vor jedem Schritt:** Zuerst gilt das Projektlimit, dann das Limit der Rolle des Schritts. Ist ein Rollen-Limit erreicht, startet der Schritt nicht.
- **Blockade:** Der Auftrag wird „blocked“ mit „Aktion notwendig“. Der Grund steht am Auftrag, etwa „Tageslimit der Rolle „developer“: 600k Tokens von 500k Tokens“. Er erscheint auch dann, wenn kein Schritt fehlgeschlagen ist. Die Problemanalyse zeigt ihn als „Budget-Blockade“.
- **Warnung ab 80 %:** Eine Push-Nachricht je Rolle, Zeitraum und Periode, z. B. „💰 Budget (developer) zu 85 % verbraucht“. Die Warnung kommt beim nächsten Prüfpunkt, also vor dem nächsten Schritt, nicht sofort bei jeder Zahl. Am nächsten Tag bzw. im nächsten Sprint kommt sie wieder.
- **Freigabe:** Der Auftrag wird wieder „geplant“, sobald sein Zeitraum wieder Luft hat: am Folgetag, im neuen Sprint oder nach dem Erhöhen bzw. Entfernen des Limits.
- **Laufender Schritt:** Ein laufender Schritt wird nicht abgebrochen. Das Limit kann daher um höchstens einen Schritt überschritten werden.

### 12.5 Bedingungen und Grenzen

- **Verbrauch je Rolle:** Er zählt Schritte, deren Agent eine Rolle hat (über `agent_id`), und den Verbrauch in `agent_usage` mit dieser Rolle.
- **Ohne Rolle:** Schritte ohne Agent (eingebaute Agents wie Chat, Auftragsautor und Visionär) zählen zu keiner Rolle. Sie bleiben nur im Projektverbrauch.
- **Gelöschter Agent:** Sein früherer Verbrauch geht in den Projekttopf über, weil die Zuordnung zur Rolle wegfällt. Das ist gewollt.
- **Historische Daten:** Schritte ohne `agent_id` werden nicht nachträglich einer Rolle zugeordnet.
- **Kosten:** Es gibt nur Token-Limits je Rolle. Kosten-Limits (USD/CHF) je Rolle kommen später.
- **Projektlimit:** Es bleibt unverändert. Ein Rollen-Limit ersetzt es nicht, es kommt zusätzlich.

### 12.6 Fehlerbehebung

| Problem | Ursache und Lösung |
|---------|--------------------|
| Ein Rollen-Limit ist gesetzt, der Schritt läuft trotzdem | Der Verbrauch der Rolle liegt noch unter dem Limit, oder der Schritt lief schon, als das Limit erreicht wurde (siehe 12.4). Prüfe mit `GET …/budget/roles`, ob `percent` über 100 liegt. |
| Verbrauch einer Rolle wirkt zu niedrig | Schritte ohne Agent oder eines gelöschten Agents zählen zu keiner Rolle (siehe 12.5). |
| Auftrag bleibt blockiert, obwohl das Limit erhöht ist | Die Freigabe läuft nach dem PUT. Liegt der Verbrauch noch über dem neuen Limit, bleibt er blockiert. Prüfe das `percent` im GET. |
| Keine Warnung, obwohl der Verbrauch über 80 % liegt | Die Warnung kommt beim nächsten Prüfpunkt. Sie wird je Periode nur einmal gesendet. Im neuen Tag bzw. Sprint kommt sie wieder. |
| 400 beim Speichern | Rolle, Zeitraum oder Grenze prüfen (Tabelle 12.3). |
| 403 beim Speichern | Dein Konto hat nicht die Rolle admin. |

---

## 13. Sprint im Review bei ausgeschalteter GitHub-Brücke

Ein Sprint kann im Status **Review** stehen, während die GitHub-Brücke des Projekts auf **„aus“** steht. Das passiert, wenn der Sprint mit einem Pull Request (Modus „Issues + PR“) abgeschlossen wurde und die Brücke danach ausgeschaltet wird. Früher blieb ein solcher Sprint für immer im Review. Jetzt verfolgt der Worker ihn weiter, auch bei „aus“.

> **Printscreens:** keine. Die Oberfläche wurde nicht im Browser aufgenommen. Beschrieben ist das Verhalten des Workers und der Statuswerte.

### 13.1 Was der Worker weiter tut

Bei Modus „aus“ läuft nur noch die Prüfung der Sprints im Review. Sie prüft den Pull Request des Sprints:

- **Grüne CI und Freigabe:** Ist die CI grün (und bei „Freigabe erforderlich“ freigegeben), merged der Worker den Pull Request.
- **Von Hand gemergt:** Wurde der Pull Request schon von einem Menschen gemergt, übernimmt der Worker den Stand.
- **Danach:** Tag auf dem gemergten `main`, lokaler `main` wird nachgezogen, Live schalten, ein eventueller CI-Bug wird geschlossen und der Sprint steht auf **Abgeschlossen**.
- **Rot:** Schlägt die CI fehl, entsteht höchstens ein Bug je CI-Lauf.

Die Prüfung läuft alle 2 Minuten.

### 13.2 Bedingungen

| Bedingung | Ergebnis |
| --- | --- |
| Sprint im Status **Review** und mit gesetztem Pull Request | Der Worker prüft ihn, auch bei Modus „aus“. |
| Modus „aus“, kein Sprint im Review | Der Worker ruft `gh` nicht auf. Der Takt endet mit „Modus aus“. |
| Modus „aus“, Sprint im Review ohne Pull Request | Nicht erfasst. Ein Sprint ohne Pull Request wird über die normale Git-Sicherung abgeschlossen, nicht über die Review-Prüfung. |
| Kein GitHub-Remote (`git_remote` nicht auf github.com) | Die Prüfung wird übersprungen, der Grund „kein GitHub-Remote“ steht in den Projekteinstellungen. Der Sprint bleibt im Review. |
| Keine Anmeldung bei `gh` | Die Prüfung wird übersprungen, der Sprint bleibt im Review, bis die Anmeldung stimmt. |
| Rate-Limit von GitHub | Das Projekt pausiert bis zum nächsten Intervall. |
| Sprint ist schon **Abgeschlossen** | Wird nicht noch einmal gemergt oder getaggt. |

### 13.3 Was du nicht erwarten solltest

- **Der Issue-Import bleibt aus.** Es werden keine neuen Issues als Bugs oder Ideen übernommen, und Statusmeldungen gehen nicht ins Issue. Dafür muss die Brücke auf „Issues“ oder „Issues + PR“ stehen.
- **Der Sprint lässt sich nicht von Hand ändern**, solange er im Review ist. Die Schnittstelle antwortet mit 409. Abschließen kann ihn nur der Worker nach dem Merge.
- **Der Autopilot startet keinen neuen Sprint**, solange ein Sprint im Review ist.

### 13.4 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Sprint bleibt im Review, obwohl der Pull Request gemergt ist | Prüfe, ob das Projekt ein GitHub-Remote hat und `gh` angemeldet ist (`gh auth status` auf dem Worker-Rechner). Ohne beides wird die Prüfung übersprungen. Danach wartet der Worker auf den nächsten Takt. |
| Sprint bleibt im Review, obwohl alles stimmt | Der Worker prüft nur Sprints mit gesetztem Pull Request (`pr_url`). Ohne ihn greift diese Prüfung nicht. Die Oberfläche zeigt diesen Wert nicht; Abhilfe nur über Entwicklung oder Datenbank. |
| CI rot, Sprint wartet | Ein Bug mit dem gekürzten CI-Auszug ist entstanden. Behebe den Fehler, dann läuft die Prüfung weiter. |

Hinweis: Die Tests für dieses Verhalten stehen in `src/runner/git-sync.test.ts` (Tests „Brücke aus: …“). Der Projekt-Testlauf 6b47961d hat `git-sync.test.ts` und `github-sync.test.ts` mit 51 von 51 grünen Tests ausgeführt. Die Tests sind mit dem alten Code nicht rot gesehen worden; dass sie dort scheitern würden, folgt aus dem Code (Abbruch mit `skipped: 'Modus aus'`).

## 14. Dokumente ändern: nur über Revisionen

Dieser Abschnitt betrifft die Seite **Dokumentation**. Eine Änderung an Titel oder Inhalt eines Dokuments gilt erst, wenn eine zweite Person sie freigibt. Eine Schnittstelle, die ein Dokument ohne Prüfung überschreibt, gibt es nicht mehr.

> **Printscreens:** keine. Die Seite lässt sich nur mit laufendem Docker-Stack und Anmeldung aufnehmen. Die Beschriftungen unten stammen aus `frontend/src/app/features/docs/docs.component.html` und sind am laufenden System zu prüfen. Platzhalter: `[Bild 8] Karte „Änderung wartet auf die Redaktion“ mit Diff`, `[Bild 9] Bearbeiten-Formular mit „Zur Prüfung einreichen“`.

### 14.1 Ablauf

1. Dokument öffnen und „✎ Bearbeiten“ klicken. Der Button erscheint nur mit dem Recht „Dokumentation bearbeiten“.
2. Titel und Inhalt ändern. Optional unter „Was wurde geändert? (optional)“ eine Notiz eintragen.
3. „Zur Prüfung einreichen“ klicken. Es erscheint die Karte „Änderung wartet auf die Redaktion“ mit dem Diff. Das Dokument bleibt bis dahin unverändert.
4. Eine Person mit der Rolle „Redaktion“ klickt „Freigeben“ oder „Ablehnen“. Eine Anmerkung ist optional.
5. Bei Freigabe übernimmt das Dokument Titel und Inhalt. Bei Ablehnung bleibt es unverändert. Beides steht im Abschnitt „Änderungsverlauf“ des Dokuments.

### 14.2 Wer darf was

| Aktion | Nötige Berechtigung | Hinweis |
| --- | --- | --- |
| Bearbeiten und einreichen | Recht „Dokumentation bearbeiten“ | Fehlt bei Repo-, Anfrage-, Test-, Einstellungs- und Workflow-Dokumenten. |
| Freigeben oder ablehnen | Rolle „Redaktion“ | Ohne die Rolle steht dort: „Freigeben kann nur jemand mit der Rolle „Redaktion“.“ |
| Eigene Änderung freigeben | Nur Administrator | Für alle anderen 403: „Eigene Änderungen muss jemand anderes aus der Redaktion freigeben.“ Die Schaltfläche erscheint trotzdem. |
| Neues Dokument anlegen | Recht „Dokumentation bearbeiten“ | Legt nur an. Ein bestehendes Dokument gleichen Titels bleibt unverändert (409). |

### 14.3 Bedingungen und Fehlermeldungen

| Eingabe | Ergebnis |
| --- | --- |
| Titel leer oder länger als 180 Zeichen, Inhalt länger als 30 000 Zeichen | 400. Nichts wird gespeichert. |
| Titel und Inhalt wie im Dokument | 400: „Es gibt keine Änderung zum Einreichen.“ |
| Einreichen bei einem Repo- oder Anfrage-Dokument | 400: „… schreibgeschützt.“ |
| Freigabe, obwohl das Dokument seit dem Einreichen geändert wurde | 409: „… ist veraltet, bitte neu einreichen.“ Das Dokument wird nicht überschrieben. Die Änderung bleibt offen, bis jemand sie ablehnt. |
| Freigabe, obwohl ein anderes Dokument den Titel schon trägt | 409: „Ein anderes Dokument trägt schon diesen Titel.“ |
| Freigabe oder Ablehnung einer schon geprüften Änderung | 409: „Diese Änderung wurde bereits geprüft.“ |

**Bedingungen:**

- Mehrere offene Änderungen je Dokument sind möglich. Wird eine freigegeben, werden die anderen veraltet und lassen sich nicht mehr freigeben.
- Eine Ablehnung ändert das Dokument nie. Der Verlauf zeigt sie mit der Anmerkung der Redaktion.
- Die Freigabe prüft den Stand bei der Einreichung. Ein Dokument, das inzwischen anders ist, wird also nicht durch eine ältere Änderung überschrieben.

### 14.4 Noch offen

- **Löschen:** Die Redaktion kann jedes Dokument löschen (Button „Löschen“ beim Bearbeiten), auch Repo- und Anfrage-Dokumente, ohne zweite Person. Dafür ist ein eigener Auftrag vorgesehen. Bis dahin ist das Löschen kein Schutz.
- **Alte Schnittstelle:** `PATCH /api/docs/:id` gibt es nicht mehr. Wer ein eigenes Skript damit geschrieben hat, muss auf `POST /api/docs/:id/revisions` umstellen.

### 14.5 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| „Bearbeiten“ fehlt | Dir fehlt das Recht „Dokumentation bearbeiten“, oder das Dokument ist schreibgeschützt (Abschnitt 14.3). |
| Freigabe meldet „veraltet“ | Ein anderer Eintrag hat das Dokument inzwischen geändert. Die alte Änderung ablehnen und den Inhalt neu einreichen. |
| Freigabe meldet 403 bei eigener Änderung | Jemand anderes aus der Redaktion muss freigeben. |
| Anlegen meldet 409 | Ein Dokument mit diesem Titel gibt es schon. Die Änderung als Überarbeitung einreichen. |

---

## 15. Auftragsautor: Anforderung und Schätzung trennen

Dieser Abschnitt betrifft den Agent **Auftragsautor** (Rolle `author`). Er schreibt aus einer Idee die Anforderung und die Schätzung. Die Anforderung endet vor dem letzten Abschnitt „Schätzung“, die Schätzung steht darin.

> **Printscreens:** keine. Die Änderung betrifft nur, wie der Worker die Antwort des Agents liest. Im Auftrag sieht man das Ergebnis als Text und Schätzwerte. Ein Bildschirmfoto lässt sich nur mit laufendem Docker-Stack und einem Auftrag mit Auftragsautor-Lauf aufnehmen. Platzhalter: `[Bild 10] Auftrag nach Auftragsautor-Lauf mit vollständiger Anforderung (Diagramme und Abgrenzung) und ausgefüllten Schätzwerten`.

### 15.1 Was sich geändert hat

Bisher nahm der Worker die erste Überschrift, die mit „Schätzung“ beginnt. Steht in den Technischen Hinweisen eine Überschrift „Schätzungsgrundlage“, schnitt das die Anforderung dort ab. Diagramme und Abgrenzung fehlten im Auftrag, und die Schätzung blieb leer, weil das JSON-Muster Mermaid-Klammern als Schätzung las. Jetzt gilt:

- Der **letzte** passende Abschnitt zählt. Frühere Abschnitte bleiben Teil der Anforderung.
- Nur diese Überschriften zählen: „Schätzung“, „Schätzung (…)“ und „Schätzung:“, Ebene 1 bis 4, Groß- und Kleinschreibung egal.
- Das JSON-Objekt wird nur innerhalb dieses Abschnitts gelesen.

### 15.2 Bedingungen

| Ausgabe des Auftragsautors | Ergebnis |
| --- | --- |
| `### Schätzungsgrundlage` in den Hinweisen, danach `## Schätzung` mit JSON | Anforderung bis einschließlich „Abgrenzung“, Schätzung wird gelesen. |
| Mehrere `## Schätzung`-Abschnitte | Der letzte gilt. |
| Nur `### Schätzungsgrundlage`, kein `Schätzung`-Abschnitt | Schätzung leer, Anforderung vollständig. |
| Überschrift „Schätzung des Aufwands“ | Gilt nicht als Schätzungsabschnitt. Die Anforderung bleibt vollständig, die Schätzung ist leer. |
| JSON-Objekt mit Mermaid-Klammern vor der Schätzung | Die Klammern werden ignoriert, es zählt nur das JSON im Schätzungsabschnitt. |

**Bedingungen:**

- Hält sich der Auftragsautor an das Format `## Schätzung` am Ende, merkst du keinen Unterschied.
- Schätzwerte, die du von Hand eingetragen hast, überschreibt der Auftragsautor nicht.
- Ungültige Werte (z. B. negative Stunden oder ein Benefit über 10) werden verworfen. Die übrigen Werte bleiben.

### 15.3 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Anforderung endet bei „Schätzungsgrundlage“ | Die alte Fassung. Auf den aktuellen Stand bringen und den Auftragsautor neu laufen lassen. |
| Schätzung ist leer, obwohl ein JSON steht | Die Überschrift passt nicht zum Format (z. B. „Schätzung des Aufwands“). Sie in `## Schätzung` ändern. |

---

## 16. Problemanalyse: „keine“ mit Begründung ist keine offene Aktion

Dieser Abschnitt betrifft die Problemanalyse eines Auftrags. Sie endet mit einer Zeile `AKTION:`. Sie sagt, was ein Mensch tun muss, oder „keine“, wenn die Agents es selbst beheben können. Nur eine echte Aktion landet unter „Aktionen“ als „Aktion notwendig“ am Auftrag.

> **Printscreens:** keine neuen. Der Fall tritt nur auf, wenn eine Problemanalyse läuft, und dafür braucht es einen laufenden Docker-Stack mit einem fehlgeschlagenen Auftrag. Der vorhandene Printscreen `aktionen-desktop.png` stammt vom 23.10.2026 und zeigt den Fehler noch. Platzhalter: `[Bild 12] Auftrag mit „keine – …“ in der Problemanalyse, ohne Eintrag unter „Aktionen“`.

### 16.1 Was sich geändert hat

Bisher galt eine Zeile nur dann als „keine“, wenn dahinter genau „keine“, „nichts“, „-“ oder „n/a“ stand. Schrieb die Analyse eine Begründung dahinter, wurde der ganze Satz als offene Aktion gespeichert. Unter „Aktionen“ wirkte der Auftrag, als warte er auf einen Menschen.

Jetzt gilt „keine“ auch mit Begründung, wenn direkt danach eines von diesen Zeichen folgt:

- Satzzeichen (`.`, `,`, `;`, `:`, `!`), zum Beispiel „keine: …“
- ein Gedankenstrich (`–` oder `—`) oder ein Bindestrich mit Leerzeichen dahinter, zum Beispiel „keine – …“
- eine öffnende Klammer, zum Beispiel „keine (Agent kann selbst beheben)“

Groß- und Kleinschreibung spielen keine Rolle. Umschließende Anführungszeichen um den Wert werden ignoriert.

### 16.2 Bedingungen

| Zeile `AKTION:` in der Problemanalyse | Ergebnis unter „Aktionen“ |
| --- | --- |
| `keine`, `nichts`, `-`, `n/a` (allein) | Keine Aktion. |
| `keine – der Analyst dokumentiert den Befund …` | Keine Aktion. |
| `keine (Agent kann selbst beheben)` | Keine Aktion. |
| `Nichts – …`, `n/a (…)`, `keine: …` | Keine Aktion. |
| `Keine Datenbank-URL hinterlegt – bitte eintragen` | Aktion „Aktion notwendig“ mit diesem Text. |
| `keine Aktion nötig` (ohne Satzzeichen, Gedankenstrich oder Klammer) | Aktion „Aktion notwendig“ mit diesem Text. |
| `Nichtsdestotrotz …`, `Keine-Ahnung-Modus …` | Aktion „Aktion notwendig“ mit diesem Text. |

**Bedingungen:**

- Die Regel gilt bei jeder Problemanalyse. Ein früherer Eintrag „Aktion notwendig: keine – …“ entfernt die nächste Analyse des Auftrags. Der Sprintbericht wird dann neu erzeugt. Du musst nichts tun.
- Eine echte Aktion bleibt bestehen. Erkannt wird nur der Anfang der Zeile, der Rest des Satzes ist egal.
- Die Länge ist begrenzt. Ein Text über 160 Zeichen wird gekürzt und endet mit „…“.

### 16.3 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Unter „Aktionen“ steht „Aktion notwendig: keine …“ | Der Eintrag stammt aus einer Analyse vor dieser Änderung. Die nächste Analyse des Auftrags entfernt ihn. Ist er noch da, ist die Analyse nicht neu gelaufen. |
| Unter „Aktionen“ steht „Aktion notwendig: keine Aktion nötig …“ | Hinter „keine“ fehlt ein Satzzeichen, ein Gedankenstrich oder eine Klammer. Das ist eine Aktion nach der Regel. Die Analyse so formulieren lassen, z. B. „keine – …“, oder den Eintrag am Auftrag von Hand entfernen. |
| Ein Auftrag mit echter Aktion wird nicht mehr angezeigt | Eine echte Aktion beginnt nicht mit „keine“, „nichts“, „-“ oder „n/a“ gefolgt von einem der Zeichen aus 16.1. Den Text am Auftrag prüfen. |

---

## 17. Verwaiste Läufe: „läuft“ ohne Prozess räumt der Worker selbst auf

Ein Agent-Lauf blieb bisher auf „läuft“, wenn die Datenbank ausfiel, während ein Auftrag abgeschlossen wurde. Dann lief kein Prozess mehr dahinter. Der Schritt ließ sich nicht abbrechen, und ein Neustart des Workers war die einzige Hilfe. Jetzt räumt der Worker solche Läufe selbst auf, ohne Neustart.

> **Printscreens:** keine. Der Fall braucht eine Datenbank, die während eines Abschlusses ausfällt, also einen laufenden Docker-Stack mit gezielter Unterbrechung. Platzhalter: `[Bild 13] Agent-Liste: Schritt „Unterbrochen: Der Lauf hatte keinen Prozess mehr …“ im Verlauf, Auftrag wieder „Geplant“` und `[Bild 14] Schritt nach „■ Abbrechen“ ohne Prozess mit dem Hinweis „Vom Benutzer abgebrochen. Der Lauf hatte keinen Prozess mehr …“`.

### 17.1 Was sich geändert hat

- **Abschluss wird wiederholt:** Scheitert der Abschluss nur an der Verbindung zur Datenbank, versucht der Worker es bis zu fünfmal im Abstand von 15 s erneut. Fehler in einer Abfrage (z. B. ungültige Daten) werden nicht wiederholt.
- **Verwaiste Läufe werden aufgeräumt:** Alle 15 s prüft der Worker die Läufe seiner Projekte. Ein Lauf auf „läuft“, den kein Auftrag dieses Workers mehr hält und der seit 5 Minuten kein Lebenszeichen hat, wird beendet. Der Schritt wird „fehlgeschlagen“ mit dem Vermerk „Unterbrochen: …“. Der Auftrag geht zurück auf „Geplant“.
- **„■ Abbrechen“ wirkt wieder:** Auf einem Schritt ohne Prozess endet „■ Abbrechen“ beim nächsten Takt. Der Schritt erhält den Vermerk „Vom Benutzer abgebrochen …“ und den Exit-Code 130, der Auftrag wird blockiert.

### 17.2 Bedingungen

| Situation | Ergebnis |
| --- | --- |
| Datenbank fällt beim Abschluss kurz aus und ist danach wieder da | Der Abschluss gelingt beim Wiederholen. Der Lauf ist sofort geschlossen. |
| Datenbank bleibt länger als rund 60 s weg | Die Wiederholungen geben auf, der Lauf bleibt zunächst auf „läuft“. Nach Rückkehr der Datenbank steht er spätestens nach etwa 5 min plus einem Takt (15 s) nicht mehr auf „läuft“. |
| Verwaister Lauf ohne Abbruch | Schritt „fehlgeschlagen“ mit „Unterbrochen: …“, Auftrag wieder „Geplant“ und damit wie gewohnt neu einplanbar. |
| Derselbe Auftrag verwaist ein drittes Mal | Auftrag „Blockiert“ statt erneut eingeplant. Der Fehler steht am Auftrag. |
| „■ Abbrechen“ auf einem verwaisten Schritt | Der Schritt endet binnen 15 s nach dem Takt, frühestens 30 s nach dem letzten Lebenszeichen. Der Auftrag wird blockiert. |
| Lauf läuft noch in einem Worker, der ihn hält | Bleibt unberührt. Der Worker räumt nur Läufe auf, die er nicht mehr hält. |
| Tokens und Kosten eines verwaisten Laufs | Bleiben stehen, wie sie beim Abbruch waren. Es werden keine Werte geschätzt. |

**Bedingungen:**

- Ein Lebenszeichen ist der Start des Laufs, der Start eines Schritts oder der letzte Eintrag im Verlauf des Schritts. Schreibt ein Schritt länger als 5 Minuten keinen Verlaufseintrag, zählt er als verwaist, auch wenn er noch läuft. 
- Die Aufräumung gilt nur für Projekte, die der Worker bedient. Läuft ein Auftrag bei einem anderen Worker, bleibt er bei diesem.
- Der Worker muss laufen, damit der Takt greift. Ist er ganz offline, räumt er beim nächsten Start auf, wie bisher.

### 17.3 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Schritt steht nach Rückkehr der Datenbank noch länger als 6 min auf „läuft“ | Der Worker läuft nicht oder nicht mit dieser Version. Den Worker-Status prüfen und neu starten, falls er nicht mehr läuft. |
| Auftrag ist „Blockiert“ mit dem Hinweis auf eine Unterbrechung | Er hat dreimal hintereinander verwaist. Die Ursache beheben (z. B. Datenbankverbindung), dann den Auftrag prüfen und neu einplanen. |
| „■ Abbrechen“ wirkt nach einer Minute noch nicht | Der Abbruch wartet auf den nächsten Takt und frühestens 30 s nach dem letzten Lebenszeichen. Spätestens nach etwa 45 s muss der Schritt beendet sein. Ist er es nicht, läuft der Worker nicht. |
| Schritt wurde beendet, obwohl der Agent noch arbeitete | Er hat länger als 5 min keinen Verlaufseintrag geschrieben. Die Grenze ist bewusst gewählt. Den Auftrag prüfen und neu starten, falls Änderungen fehlen. |

---

## 18. Push-Abos: nur eigene Geräte, nur bekannte Push-Dienste, Abmelden entfernt das Abo

Dieser Abschnitt betrifft **Einstellungen → App & Benachrichtigungen** (Schalter „Push-Nachrichten“) und **Einstellungen → Sicherheit** (Schaltfläche „Abmelden“). Die Regeln gelten für jeden Benutzer und für den Systemadministrator.

> **Printscreens:** keine. Ein Browserlauf mit Push braucht eine HTTPS-Adresse, einen Service Worker und die Erlaubnis des Browsers. Platzhalter: `[Bild 15] Einstellungen → App & Benachrichtigungen mit eingeschaltetem Schalter „Push-Nachrichten“ und Schaltfläche „Testnachricht senden“` und `[Bild 16] Einstellungen → Sicherheit mit „Abmelden“`.

### 18.1 Was sich geändert hat

- **Nur bekannte Push-Dienste:** Der Server nimmt ein Gerät nur an, wenn sein Endpunkt von einem Browser-Push-Dienst stammt: Google (FCM, Chrome/Edge/Android), Mozilla (Firefox), Apple (Safari, iPhone) oder Windows. Andere Adressen werden abgelehnt, und der Server fragt sie nie an. Beim Senden gilt dieselbe Prüfung für alle gespeicherten Geräte.
- **Ein Gerät gehört dem Benutzer, der es angemeldet hat:** Nur er kann das Gerät ändern oder abmelden. Meldet sich ein anderer Benutzer an, bleibt das fremde Gerät unverändert. Die Antwort ist dieselbe, es gibt keinen Hinweis auf fremde Geräte.
- **Abmelden entfernt auch das Push-Abo:** Wer sich über „Abmelden“ abmeldet, entfernt das Abo dieses Geräts auf dem Server und im Browser. Danach endet die Sitzung, und die Seite lädt neu.
- **Abos ohne Konto:** Ein Abo des Systemadministrators ohne Konto gehört zum Administrator-Konto der `.env`. Ein Logout ohne gültige Sitzung löscht nie ein Abo.
- **Ungültige Altdaten:** Gespeicherte Geräte mit einer Adresse außerhalb der Liste werden beim nächsten Senden verworfen, ohne dass der Server sie anfragt.

### 18.2 Bedienung

| Aktion | Wo | Ergebnis |
| --- | --- | --- |
| Push-Nachrichten einschalten | Einstellungen → App & Benachrichtigungen → „Push-Nachrichten“ | Der Browser fragt nach der Erlaubnis. Nach „Erlauben“ ist das Gerät angemeldet. |
| Testnachricht prüfen | „Testnachricht senden“ (nur sichtbar, wenn Push eingeschaltet ist) | Eine Nachricht kommt auf dem Gerät an. |
| Dieses Gerät abmelden | Einstellungen → Sicherheit → „Abmelden“ | Das Push-Abo dieses Geräts endet, dann die Sitzung. |

**Bedingungen und Grenzen:**

- Push braucht HTTPS. Eine eigene Domain mit Caddy und Port 443 ist in `installation.md` beschrieben. Auf dem iPhone funktioniert Push nur in der installierten App.
- Ein Gerät lässt sich nur mit dem Konto ändern, das es angemeldet hat. Abmelden mit einem anderen Konto entfernt das Abo nicht.
- Scheitert der Browserteil beim Abmelden (z. B. kein Service Worker), wird trotzdem abgemeldet. Das Abo am Server entfernt der Logout nur, wenn sein Endpunkt bekannt war. Sonst bleibt es, bis der Push-Dienst es als abgemeldet meldet.
- Der Server prüft die Adresse beim Anmelden und beim Senden. Die Liste der Push-Dienste wird im Code gepflegt. Neue Browser-Dienste nimmt die Administration hinzu.

### 18.3 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| „Ungültige Push-Anmeldung.“ beim Einschalten | Die Adresse stammt nicht von einem bekannten Push-Dienst. Den Browser wechseln oder die Administration informieren. Die Prüfung nicht umgehen. |
| Gerät bekommt nach Anmeldung mit einem anderen Konto keine Nachrichten | Das Gerät hat noch ein Abo des vorherigen Kontos, das nicht abgemeldet wurde (z. B. abgelaufene Sitzung). Ein fremdes Abo wird nicht übernommen. Mit dem vorherigen Konto abmelden, dann mit dem neuen Konto Push einschalten. Ist die alte Sitzung abgelaufen, die Benachrichtigungen dieser Seite in den Browser-Einstellungen zurücksetzen. |
| Nach „Abmelden“ kommen trotzdem Nachrichten | Das Abo konnte nicht entfernt werden (z. B. Browserteil fehlgeschlagen, Endpunkt unbekannt). Die Administration informieren. |

---

## Verwandte Dokumente

- [`agents-und-rechte.md`](agents-und-rechte.md): Rechte-Tabelle, Trigger und Sicherheitsregeln
- [`workflows.md`](workflows.md): Ablauf der Agents im Auftrag
- [`laufzeit.md`](laufzeit.md): Worker und Betrieb
- [`installation.md`](installation.md): HTTPS und Push-Dienste bei eigener Domain
- [`push-abos-ssrf-besitz-logout-2026-10-25.md`](push-abos-ssrf-besitz-logout-2026-10-25.md): Entwicklerbericht zu Abschnitt 18 (Ursache, Umsetzung, offener Test)
