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
- **Dateibefehle in der Shell sind gesperrt:** Agents können Dateien nicht mehr über Shell-Befehle anlegen, ändern oder löschen. Gesperrt sind `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`, außerdem `ln`, `tee`, `truncate`, `install`, `unlink`, `shred`, `patch`, `dd` sowie `find` mit `-delete`, `-exec` oder `-fprint`. Das gilt für jeden Teil einer Befehlskette (`;`, `&&`, `||`, `|`) und auch, wenn der Befehl mit Pfad (`/bin/rm`), in Anführungszeichen oder mit Präfix (`xargs`, `command`, `sudo`) geschrieben ist. `sed` ist ganz gesperrt, also auch zum bloßen Lesen. Dateien ändern Agents nur über die Datei-Werkzeuge; dort prüft AIdeation die Rechte der Rolle und den erlaubten Ordner. Grund: Die Claude-CLI gibt die ersten sieben Befehle im Modus „Dateien bearbeiten ohne Rückfrage“ ohne Prüfung frei, also auch außerhalb des erlaubten Ordners. Eigene Agent-Befehle und Routinen, die einen dieser Befehle nutzen, schlagen deshalb fehl. Lesen geht über das Lese-Werkzeug.
- **Befehle werden wie in Bash zerlegt:** Anführungszeichen und Escapes zählen. `'…'`, `"…"` und `$'…'` löst AIdeation wie die Shell auf, damit Quoting keinen Dateibefehl oder keine Umleitung versteckt. Gesperrt sind: escapte Anführungszeichen (`\'`, `\"`), offene Anführungszeichen, ein Backslash am Zeilenende, `$(…)`, Backticks, Subshells, `&` am Ende, Heredocs (`<<`), `${…}` und Shell-Schlüsselwörter an Befehlsposition (`if`, `for`, `while`, `!`, `{ … }`). Wer einen eigenen Agent-Befehl schreibt, setzt Argumente mit Leerzeichen in ganze Anführungszeichen, z. B. `git log --grep='a b'`, und verzichtet auf Escapes.
- **Rechte gelten für den Pfad, nicht für die Schreibweise:** Ein Schrägstrich am Ende der Adresse ändert an den Rechten nichts. Wer nur die Rolle „Planung“ hat, bekommt für `PATCH …/development/<id>/` mit `agentId` (Agent starten), für `…/approve/` (Freigabe) und für `…/git-sync/` (Sprint-Sync) dieselbe Antwort wie ohne Schrägstrich: 403. Zum Starten eines Agents oder zum Freigeben braucht es die Rolle „Ausführen“.
- **Abbrechen und Zeitlimit stoppen den Agent wirklich:** Über „■ Abbrechen“ (nur bei einem aktiven Agent) oder nach dem Zeitlimit je Schritt (Standard 30 min) erhält der Agent ein Stopp-Signal. Es erreicht das laufende Modell, jedes Datei-Werkzeug und laufende Befehle samt ihren Prozessen, etwa Dev-Server oder Testläufer. Danach startet kein weiteres Werkzeug, und es wird keine Datei mehr geschrieben. Commit und Rückkehr auf den Basis-Branch laufen erst, wenn der Agent wirklich beendet ist. Dafür wartet der Schritt ohne zeitliche Obergrenze. Tokens und Kosten des abgebrochenen Laufs bleiben erhalten. Ein Abbruch gilt weder als Erfolg noch wird er wiederholt. Ein Zeitlimit wird wie ein vorübergehender Fehler einmal nach 30 s wiederholt, wenn das Budget es erlaubt.
- **Bestehende Funktionen bleiben:** Die Share-Bar der Prüfergebnisse, der Abbrechen-Button und der Klick auf die Agent-Aktivität funktionieren wie bisher.
- **Review-Container (nur Administratoren):** Der Container sieht weder die `.env` noch die Haupt-Datenbank. Er bekommt nur einen eigenen Review-DB-User ohne Superuser-Rechte und einen Projekt-Cache. Für Projekte mit eigener Datenbank schlägt der Review-Slot derzeit fehl, statt auf die Haupt-Zugänge zurückzufallen. Eine Lösung ist noch offen.

---

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Agent zeigt „Worker offline“ | Der Worker läuft nicht. Prüfe den Worker-Dienst auf dem Host (siehe [`laufzeit.md`](laufzeit.md)). |
| Ein Agent fehlt in der Liste | Der Agent gehört zu einem anderen Projekt oder ist nicht angelegt. Prüfe, ob das richtige Projekt aktiv ist. |
| Rechte-Chip zeigt „nein“, der Agent darf aber Befehle ausführen | Das Chip zeigt den Standardwert der Rolle. Der Befehl des Agents (Claude-CLI oder lokales Modell) kann abweichen. Der Hinweis „je nach Befehl“ weist darauf hin. |
| Agent-Lauf meldet „ist für Agents gesperrt – Dateien nur mit den Datei-Werkzeugen anlegen, ändern oder löschen“ | Der Befehl enthält einen Dateibefehl wie `rm`, `mv`, `cp`, `sed` oder `touch` (siehe Abschnitt 3). Der Agent muss die Änderung über die Datei-Werkzeuge machen. Ändert sich ein eigener Agent-Befehl oder eine Routine, den Befehl umstellen oder den Schritt entfernen. Die Meldung nennt den Teilbefehl, der gesperrt ist. |
| Agent-Lauf meldet „Escapte Anführungszeichen (\' bzw. \") sind gesperrt“, „Offene Anführungszeichen …“ oder „Der Befehl lässt sich nicht eindeutig zerlegen …“ | Der Befehl ist so geschrieben, dass AIdeation ihn nicht sicher lesen kann (siehe Abschnitt 3). Argumente in ganze Anführungszeichen setzen (`'…'` oder `"…"`), statt mit `\'` oder `\"` zu escapen, Backslashes am Zeilenende entfernen und Befehle in einfache Teilbefehle aufteilen. Die Meldung nennt den Grund. |
| Agent-Lauf meldet „Abgebrochen: Der Agent wurde gestoppt.“ | Jemand hat „■ Abbrechen“ genutzt, oder der Worker wurde beendet. Der Lauf gilt nicht als Erfolg und wird nicht automatisch wiederholt. Prüfe vor einem neuen Start, welche Dateien der Agent bereits geschrieben hat. |
| Agent-Lauf meldet „Zeitlimit erreicht“ | Der Schritt lief länger als das Zeitlimit (Standard 30 min je Schritt). Er wird einmal nach 30 s wiederholt, wenn das Budget es erlaubt. Scheitert auch der zweite Versuch, den Auftrag in kleinere Teile aufteilen. |
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

**Git des Workers:** Git und `gh` laufen mit derselben Allowlist. GitHub-Tokens bleiben erlaubt, damit der Push funktioniert. Git-Hooks sind aus (`core.hooksPath` zeigt auf `/dev/null`). Alle Commits des Workers entstehen mit `--no-verify`. Ein Pre-Commit-Hook im Projekt läuft daher nicht. Lint und Format müssen über das Test-Gate geprüft werden.

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

## 6. Datenbank-Abfragen (`run_sql`) für Entwickler und Chat-Assistenten

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

---

## 9. Routinen: Prüfbefehle (npm audit, git grep)

Zeitgesteuerte Routinen (Agent-Rolle „Routine“) können jetzt die Prüfbefehle ausführen, die ihre Vorlagen verlangen. Vorher bekamen sie kein Befehlsrecht, oder die Claude-CLI verweigerte den Befehl im Hintergrund. Die Routine meldete dann „Messwert fehlt“ und legte keinen Bug an.

[Bild 8: Routine „Nächtlicher Sicherheits-Check“ mit dem Schalter „aktiv“ und dem Ausgabeziel „Bugs“]

### 9.1 Welche Befehle freigegeben sind

Die Prüf-Gruppe ist eingebaut. Sie lässt nur diese Befehle zu:

| Befehl | Zweck |
| --- | --- |
| `npm audit` (auch mit `--json`) | Sicherheitslücken in den Abhängigkeiten |
| `npm outdated` | veraltete Abhängigkeiten |
| `git ls-files` | Dateien im Repository auflisten |
| `git grep` (z. B. `git grep -n TODO`) | Text im Repository suchen |

Das ist eine Ausnahme nur für Routinen. Sie erscheint nicht als Projektgruppe, die man an- oder abschaltet.

### 9.2 Bedingungen und Grenzen

- **Nur die Rolle „Routine“.** Entwickler, Assistent und Tester bekommen diese Befehle nicht, auch nicht über eine eigene Zuweisung am Agent.
- **Nur lesen.** Routinen bekommen keine Datei-Werkzeuge zum Schreiben. Sie ändern nichts im Projekt. Ergebnisse gehen nur über die Marker (`@@BUG`, `@@IDEA`, `@@ORDER`) weiter, und daraus entstehen Bugs, Ideen oder Aufträge.
- **Gesperrt bleiben:**
  - `npm audit fix` (auch `npm audit --json fix` und mit Anführungszeichen), weil es `package-lock.json` ändert.
  - `git grep -O` und `--open-files-in-pager` (Pager bzw. Reihenfolge-Datei), auch in zusammengefassten Kurzoptionen wie `-iOless`.
  - `git grep --no-index`, `--no-exclude-standard` und `-f`/`--file` mit einer Datei außerhalb des Projekts.
  - Pfade außerhalb des Projektordners (absolute Pfade und `..`).
  - Geheimnis-Dateien wie `.env`.
  - Escapte Anführungszeichen (`\"`, `\'`) und die anderen Schreibweisen, die der Befehlswächter in Abschnitt 3 nennt.
- **Lokales Modell (Standard ohne CLI):** Routinen bekommen `run_command`, aber kein `write_file` und kein `edit_file`. Ohne Rechte-Kontext (Datei- und Befehlsrechte) gibt es gar keine Shell. Das ist Absicht (fail-closed).
- **Claude-CLI:** Die Freigabe läuft über dieselben Regeln wie die übrigen Befehle. Die Routine bekommt die Prüf-Gruppe auch dann, wenn ihre Projektgruppen eingeschränkt sind.
- **Offen:** Routinen bekommen weiterhin alle Befehle der freigeschalteten Projektgruppen (z. B. `npm run`). Diese Einschränkung ist ein eigener Auftrag und noch nicht umgesetzt.

### 9.3 Vorlagen, die diese Befehle nutzen

Die Vorlagen werden einmal je Projekt angelegt. Sie sind immer deaktiviert und nur lesend. Du schaltest sie selbst ein.

| Vorlage | Befehle | Ergebnis |
| --- | --- | --- |
| Nächtlicher Sicherheits-Check (02:00, Fenster 22–06 Uhr) | `npm audit`, `npm outdated` | Bug je Sicherheitslücke ab Schwere „moderate“ |
| Wöchentlicher Doku-Abgleich | `git ls-files` | Aufträge |
| Tote Dateien und TODOs finden | `git ls-files`, `git grep -n TODO` | Ideen mit Fundstellen |
| Testabdeckung unter 75 % melden | Coverage-Messung | Aufträge; fehlende Messwerte gelten als Hinweis, nicht als bestanden |

[Bild 9: Routine „Nächtlicher Sicherheits-Check“ nach einem Lauf mit einem neuen Bug aus `npm audit`]

### 9.4 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Routine meldet „Messwert fehlt“ oder legt keinen Bug an | Die Routine hat keine Shell oder der Befehl wurde gesperrt. Prüfe die Meldung im Lauf. Bei einem Befehl mit `-O`, `fix` oder einem Pfad außerhalb des Projekts ist die Sperre richtig. Den Befehl ohne diese Teile neu formulieren. |
| Lauf meldet „Escapte Anführungszeichen“ | Argumente in ganze Anführungszeichen setzen (`'…'` oder `"…"`), statt zu escapen. Siehe Abschnitt 4. |
| `npm audit` liefert keine Ergebnisse oder einen Fehler | `npm audit` braucht Netzzugang zum Paketregister. Die Ausgabe des Laufs zeigt, ob der Befehl selbst fehlgeschlagen ist. Diesen Fall habe ich nicht gegen einen echten Lauf geprüft. |

---

## Verwandte Dokumente

- [`agents-und-rechte.md`](agents-und-rechte.md): Rechte-Tabelle, Trigger und Sicherheitsregeln
- [`workflows.md`](workflows.md): Ablauf der Agents im Auftrag
- [`laufzeit.md`](laufzeit.md): Worker und Betrieb
