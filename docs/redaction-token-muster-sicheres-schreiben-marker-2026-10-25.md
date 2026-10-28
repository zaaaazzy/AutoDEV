# Redaction mit Token-Mustern, sicheres Schreiben, Marker nur am Zeilenanfang (25.10.2026)

Auftrag 87704371 (Bugfix, Sprint 23, aus dem Code-Review vom 21.10.2026, Stand `a4971e9`).

## Problem
- `redactOutput` ersetzte nur Werte aus dem Worker-Environment. Token-Formate (`sk-ant-`, `ghp_`, PEM, JWT, Bearer, Zugangsdaten in URLs) blieben stehen. `run_sql`-Ergebnisse und Agent-Ausgaben gingen so ungefiltert in `chat_messages`, die Anfragen-Doku und `agent_usage.prompt`.
- Der Ollama-Pfad prüfte den Pfad vor `mkdir`/`writeFile`. Beide folgen danach Links (TOCTOU): Ein parallel gesetzter Link konnte den Schreibvorgang umlenken.
- `@@ORDER`, `@@BUG` und `@@IDEA` zählten irgendwo in einer Zeile, auch in zitiertem Dateiinhalt, und erzeugten ungewollte Backlog-Einträge.

## Änderung

### 1. Redaction (`src/core/secret-mask.ts`, `src/core/command.ts`, `src/agent/tool-sql.ts`)
- Neu: `maskTokens(text, mask)` in `secret-mask.ts`. Nur eindeutige Zugangsdaten: Token-Formate, PEM-Blöcke, JWT, `Bearer`/`Basic`/`Token` mit tokenartigem Wert (mindestens 16 Zeichen, mit Ziffer) und Passwörter in URLs. Ohne E-Mail, IP und `schlüssel=wert`.
- `maskSecrets` ruft intern `maskTokens` auf und hängt E-Mail, IP und `schlüssel=wert` an. Sein Verhalten ändert sich nicht (der Git-Sync und der Betriebs-Rückkanal nutzen es).
- `redactOutput(output, env, { tokens })` wendet `maskTokens` nach den Umgebungswerten an, auch bei gekürzter Ausgabe. `tokens: false` schaltet das ab.
- `git-helpers.ts`: Für `git diff` wird `tokens: false` gesetzt, weil `stageAll` im Diff nach Zugangsdaten sucht (`filesWithSecrets`). Mit Maske fände es keine mehr.
- `tool-sql.ts`: `clipCell` maskiert Strings **vor** dem Kürzen (sonst bliebe ein angeschnittener Schlüssel stehen). `rowsText` maskiert das JSON noch einmal. SQL-Fehlermeldungen werden maskiert (sie zitieren Werte, z. B. „Key (token)=(…) already exists“).
- `runCommand` schwärzt weiter nur die Umgebung. Seine Ausgabe wird noch ausgewertet und erst über `redactOutput` gespeichert.

### 2. Sicheres Schreiben (`src/agent/tool-paths.ts`, `src/agent/ollama-tools.ts`)
- Neu: `writeProjectFile(cwd, target, content)`.
  1. Ordner anlegen (`mkdir -p`).
  2. Erst danach den wirklichen Pfad (`realpath`) prüfen (`checkedPath`, aus `resolveInside` herausgelöst).
  3. In eine neue Temp-Datei im Zielordner schreiben (`O_EXCL`, `O_NOFOLLOW`).
  4. Vor dem `rename` prüfen, ob der Zielordner noch derselbe wirkliche Pfad ist, sonst Abbruch.
  5. `rename` auf das Ziel. Bei Fehlern wird die Temp-Datei gelöscht.
- Vorhandene Dateien behalten ihre Rechte. Links im Projekt bleiben erhalten (geschrieben wird ihr Ziel).
- `write_file` und `replace_in_file` in `ollama-tools.ts` nutzen die Funktion.
- Zusätzlich: `SECRET_SAMPLES` und eine Zeile in `tool-paths.ts` sind nur umformatiert.

### 3. Marker (`src/agent/visionary.ts`, `src/agent/routine.ts`)
- `parseMarkerLines`: Ein Marker zählt nur am Zeilenanfang (davor Einrückung und ein Listenpunkt `- `, `* `, `1. `) und nicht in Codeblöcken (```` ``` ```` oder `~~~`; Ende nur mit gleichem Zeichen und mindestens gleicher Länge).
- Marker mitten im Satz, in Backticks, in Zitaten (`> `) oder in zitiertem Dateiinhalt legen nichts an.
- `routine.ts`: Der Prompt zeigt die Marker ohne Backticks und weist darauf hin, dass sie direkt am Zeilenanfang stehen müssen.

## Tests
- `src/core/command.test.ts`: `redactOutput` maskiert Token-Formate; Gegenproben (`sk-`, `ghp_`, `Bearer authentication`, Token- und Kostenzahlen, `session.ts:12`, E-Mail, IP) bleiben unverändert.
- `src/agent/tool-sql.test.ts`: Tokens in Zellen und Fehlermeldungen maskiert.
- `src/agent/tool-paths.test.ts`: `writeProjectFile` (Link-Umlenkung, Rechte, Temp-Datei aufgeräumt).
- `src/agent/visionary.test.ts`: Marker nur am Zeilenanfang und ausserhalb von Codeblöcken.
- Die Secret-Prüfung im Git-Sync bleibt zu prüfen: `src/runner/git-sync.test.ts`, `report-folders.test.ts`, `secret-holdback.test.ts`.

## Doku
`docs/laufzeit.md` (Abschnitt Befehlsausgabe) und `docs/agents-und-rechte.md` (Schreiben, Marker).

## Worauf zu achten ist
- **Neue `redactOutput`-Aufrufer:** Wertet ein Aufrufer die Ausgabe selbst nach Zugangsdaten aus, muss er `{ tokens: false }` setzen, sonst findet er nichts mehr. Bisher betrifft das nur `git diff`.
- **Zusätzliche Muster:** Neue Token-Formate gehören in `secret-mask.ts`. Dort wirken sie dann auf Git-Sync, Betriebs-Rückkanal und Ausgabe-Redaction zugleich.
- **Maskiert werden Zahlen nicht:** Token- und Kostenzahlen (`input_tokens`) bleiben bewusst lesbar.
- **Marker im Fliesstext:** Agents, die Marker nach einem Satz in derselben Zeile ausgeben, erzeugen jetzt nichts mehr. Das ist beabsichtigt.
- **Schreiben ersetzt das Ziel still (`rename`):** Der Aufrufer entscheidet wie bisher, ob Überschreiben erlaubt ist. `writeProjectFile` prüft das nicht.
- **Stand der Prüfung:** Der Entwickler hat die ganze Suite mit `npm test` laufen lassen; einzelne Läufe mit `tsx --test` brauchten eine Freigabe. Zum Zeitpunkt der Doku sind `src/agent/tool-sql.test.ts` und `src/core/command.test.ts` im Arbeitsordner noch geändert, aber nicht eingecheckt (vermutlich Ergänzungen des Testers).

## Geänderte Dateien
`docs/agents-und-rechte.md`, `docs/laufzeit.md`, `src/agent/ollama-tools.ts`, `src/agent/routine.ts`, `src/agent/tool-paths.ts`, `src/agent/tool-paths.test.ts`, `src/agent/tool-sql.ts`, `src/agent/tool-sql.test.ts`, `src/agent/visionary.ts`, `src/agent/visionary.test.ts`, `src/core/command.ts`, `src/core/command.test.ts`, `src/core/secret-mask.ts`, `src/runner/git-sync/git-helpers.ts`.
