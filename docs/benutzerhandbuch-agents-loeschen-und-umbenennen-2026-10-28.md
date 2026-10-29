# Benutzerhandbuch: Agents löschen und umbenennen mit `git rm` und `git mv`

Auftrag 49111ea3 (Bugfix, Sprint 23). Dieses Kapitel beschreibt, was Agents jetzt beim Löschen und Umbenennen von Dateien dürfen, unter welchen Bedingungen, und wie du eine Sperre erkennst und behebst.

> **Was sich geändert hat:** Vorher sperrte der Wächter alle Datei-Befehle der Shell (`rm`, `mv`, `cp` …). Die Datei-Werkzeuge können nicht löschen. Ein „Umbenennen“ entstand darum als Kopie, und das Original blieb liegen. Beobachtet bei Mainty: Migrationen bekamen eine neue Nummer, die alte Datei blieb, und der Migrations-Runner meldete „Migration versions must be unique“.
>
> Jetzt dürfen Agents Dateien über `git rm` löschen und über `git mv` umbenennen. `rm`, `mv` und `cp` bleiben gesperrt. Der Wächter prüft jeden Aufruf.
>
> **Printscreens:** keine. Für diesen Auftrag wurde die App nicht gestartet, und es gab keinen Browser-Lauf. Die Beschreibung stammt aus dem Code (`src/agent/command-checks.ts`, `src/agent/permission-rules.ts`, `src/agent/tool-permissions.ts`, `src/agent/agent-guard.ts`) und aus `docs/agents-und-rechte.md`. Fehlende Aufnahmen stehen in Abschnitt 6.

---

## 1. Was Agents dürfen

| Aktion | Befehl | Nötiges Recht der Rolle | Gilt nur für |
| --- | --- | --- | --- |
| Löschen | `git rm <pfad>` | „Dateien ändern“ | Dateien und Ordner im Projekt bzw. in den erlaubten Ordnern |
| Umbenennen | `git mv <alt> <neu>` | „Dateien anlegen“ **und** „Dateien ändern“ | dasselbe; Quelle und Ziel liegen im Projekt |

Die Rechte stehen in der Rechte-Auswahl der Rolle (Rechte-Chips im Agents-Bereich, siehe `docs/benutzerhandbuch-dashboard-agents.md`). Die Hilfetexte der Rechte nennen Löschen und Umbenennen ausdrücklich. Den genauen Ort in der Oberfläche habe ich nicht im Browser geprüft.

Beispiele:

- `git rm migrations/009_alt.sql` löscht eine Datei, die Git kennt.
- `git mv migrations/010_neu.sql migrations/011_neu.sql` benennt eine committete Datei um. Das Original ist danach weg.
- `git rm -r build-alt` löscht einen Ordner. Enthält er einen geschützten Eintrag (z. B. `.env`), wird der Befehl gesperrt.

---

## 2. Bedingungen

Ein Befehl läuft nur durch, wenn alle diese Punkte erfüllt sind:

1. **Rechte:** Die Rolle hat „Dateien ändern“ (für `git rm`) bzw. zusätzlich „Dateien anlegen“ (für `git mv`). Ohne diese Rechte ist der Befehl gesperrt, egal welche anderen Regeln der Agent hat.
2. **Erlaubte Optionen, genau so geschrieben:**
   - `git rm`: `-q`/`--quiet`, `-n`/`--dry-run`, `--cached`, `-r`
   - `git mv`: `-v`/`--verbose`, `-n`/`--dry-run`
   - Gesperrt sind `-f`/`--force` (überschreibt vorhandene Dateien), `--pathspec-from-file` und alle Abkürzungen davon. Auch Optionen vor dem Unterbefehl (`git -C …`) sind gesperrt.
3. **Einfache Pfade:** Jeder Pfad (bei `git mv` Quelle und Ziel) ist ein relativer Pfad ohne `..`. Gesperrt sind Platzhalter (`*`, `?`, `[`), Variablen, `~` und Pathspec-Magie (`:(top)`, `:!`, `:/`).
4. **Im Projekt:** Der Pfad liegt im Projektordner, auch nach dem Auflösen von Symlinks. Liegt er außerhalb, ist der Befehl gesperrt.
5. **Erlaubte Ordner:** Hat die Rolle eine Ordner-Einschränkung, muss der Pfad darin liegen.
6. **Nicht das Projekt selbst:** `git rm -r .` ist gesperrt. Gelöscht wird nur, was einzeln benannt ist.
7. **Nicht geschützt:** `.env`, `.git/`, `.claude/`, `.npmrc` und die anderen geschützten Dateien sind gesperrt, auch als Ziel von `git mv`.
8. **Ordner mit geschützten Inhalten:** Bei einem Ordner sucht der Wächter darin nach geschützten Einträgen. Findet er einen, ist der Befehl gesperrt. Enthält ein Ordner mehr als 5000 Einträge, ist der Befehl ebenfalls gesperrt. Dann bitte kleinere Ordner angeben.

Der Wächter prüft jeden Aufruf. Breite eigene Regeln wie `Bash(git:*)` umgehen diese Prüfung nicht. Befehle mit `;`, `&&`, `|` oder `$(…)` werden je Teil geprüft. `timeout 30 git rm …` wird wie `git rm …` geprüft. Wrapper wie `command git rm` bleiben gesperrt.

---

## 3. Was gesperrt bleibt

| Befehl | Ergebnis |
| --- | --- |
| `rm`, `mv`, `cp`, `unlink` und die übrigen Datei-Befehle (siehe Abschnitt 4) | gesperrt, wie bisher |
| `git rm -f …`, `git mv -f …` | gesperrt (`-f` überschreibt) |
| `git rm -r .` oder `git rm -r <ganzes Projekt>` | gesperrt |
| `git rm .env`, `git mv README.md .git/x` | gesperrt (geschützt) |
| `git rm ../x`, `git rm /etc/x`, `git rm ~/x` | gesperrt (außerhalb des Projekts) |
| `git rm 'datei*'`, `git rm $DATEI` | gesperrt (Platzhalter bzw. Variable) |
| `git -C anderer/ordner rm x` | gesperrt (Option vor dem Unterbefehl) |
| `git rm a && rm b` | gesperrt (die Kette enthält `rm`) |
| `git rm datei` bei fehlendem Recht „Dateien ändern“ | gesperrt |
| `git mv a b` bei nur „Dateien ändern“ | gesperrt (Umbenennen braucht auch „Dateien anlegen“) |
| `git rm --pathspec-from-file=liste` | gesperrt |

---

## 4. Warum nur `git rm` und `git mv`

Die Claude-CLI gibt die Befehle `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed` und `find` mit `-delete`/`-exec`/`-fprint` ohne Prüfung frei, wenn Agents im Modus „Dateien bearbeiten ohne Rückfrage“ laufen. Dabei umgeht sie die Ordner-Einschränkung. Deshalb bleiben diese Befehle gesperrt. Nur `git rm` und `git mv` sind eng freigegeben, weil sie die oben genannten Prüfungen durchlaufen.

---

## 5. Was du beim Lauf siehst

Ist ein Befehl gesperrt, bricht der Schritt mit einer Meldung ab. Die Meldung nennt den gesperrten Teil. Die häufigsten Meldungen:

| Meldung (Auszug) | Was zu tun ist |
| --- | --- |
| „… dieser Befehl ist für Agents gesperrt – … mit „git rm <pfad>“ löschen und mit „git mv <alt> <neu>“ umbenennen.“ | Der Befehl enthält `rm`, `mv`, `cp` oder einen anderen Datei-Befehl. Den Schritt auf `git rm` bzw. `git mv` umstellen oder die Datei-Werkzeuge nutzen. |
| „Löschen braucht das Recht „Dateien ändern“, Umbenennen zusätzlich „Dateien anlegen“.“ | Der Rolle das fehlende Recht geben, oder den Schritt von einer anderen Rolle ausführen lassen. |
| „Option „-f“ ist bei git rm gesperrt (erlaubt: …).“ | `-f` weglassen. Eine vorhandene Zieldatei muss vorher gelöscht werden. |
| „… nur einfache relative Pfade (ohne „..“, Platzhalter, Variablen oder Pathspec-Magie).“ | Den Pfad ausschreiben, ohne `*`, `$VAR` oder `..`. |
| „… liegt ausserhalb des Projektordners.“ | Nur Pfade im Projekt angeben. |
| „… liegt ausserhalb der erlaubten Ordner (…).“ | Den Pfad in einen der erlaubten Ordner legen oder die Ordner-Einschränkung der Rolle anpassen. |
| „… ist geschützt.“ | Geschützte Dateien (`.env`, `.git`, `.claude`, `.npmrc`) werden nie von Agents gelöscht oder umbenannt. Von Hand erledigen. |
| „… enthält … (geschützt).“ | Den Ordner aufteilen und den geschützten Eintrag ausnehmen. |
| „… enthält zu viele Einträge – bitte kleinere Ordner angeben.“ | Den Ordner aufteilen, bis jeder Teil unter 5000 Einträge hat. |
| „nicht das ganze Projekt, nur einzelne Dateien oder Ordner.“ | Die Dateien einzeln angeben. |

---

## 6. Printscreens (noch offen)

Für diesen Auftrag gibt es keine Aufnahmen. Diese wären hilfreich:

1. Agents → Rollen: die Rechte-Chips „Dateien anlegen“ und „Dateien ändern“, mit Hover-Text zu `git rm` und `git mv`.
2. Ein Agent-Lauf, der mit `git mv` umbenennt, im Protokoll mit der Ausgabe von `git status` danach.
3. Eine Sperre im Protokoll mit der Meldung „… für Agents gesperrt …“.

---

## 7. Fehlerbehebung

| Problem | Ursache und Behebung |
| --- | --- |
| Umbenennen erzeugt wieder eine Kopie, das Original bleibt. | Der Agent nutzt das Datei-Werkzeug statt `git mv`. Den Schritt im Agenten-Prompt auf `git mv <alt> <neu>` umstellen. |
| `git mv` schlägt fehl, obwohl das Recht „Dateien ändern“ gesetzt ist. | Das Recht „Dateien anlegen“ fehlt. Umbenennen braucht beide Rechte. |
| `git rm` findet die Datei nicht oder löscht nichts. | Git kennt die Datei nicht. Eine im selben Schritt neu angelegte, nicht committete Datei lässt sich mit `git rm` nicht löschen. Erst committen, dann löschen. |
| Eine Migration bleibt doppelt nach dem Umbenennen. | Der Lauf ist vor dem Umbenennen abgebrochen. Die Meldung im Protokoll prüfen (Abschnitt 5). |

---

## 8. Hinweise für Entwickler

- **Lokales Modell (Ollama):** `git rm` und `git mv` sind dort absichtlich noch nicht freigegeben. `isAllowedCommand` kennt sie nicht, und `bashProblem` in `ollama-tools.ts` bekommt keine Datei-Rechte. Das ist ein Folgeauftrag.
- **Regeln:** `GIT_RM_RULE`, `GIT_MV_RULE` und `fileGitRules` in `src/agent/permission-rules.ts`. Der Wächter prüft mit `gitFileProblem` in `src/agent/command-checks.ts`.
- **Tests:** `src/agent/agent-guard.test.ts` („git rm und git mv …“), `src/agent/agent-permissions.test.ts`, `src/agent/tool-permissions.test.ts` und `src/agent/command-checks.test.ts`.
- **Entwicklerbericht:** `docs/agents-loeschen-und-umbenennen-git-rm-mv-2026-10-28.md`.
- **Offen:** Prettier ist auf den geänderten Dateien noch nicht gelaufen. In `src/agent/permission-rules.ts` fehlt das Leerzeichen bei `PSEUDO_COMMANDS =new Set`. Ein echter Lauf mit der Claude-CLI (committete Datei per `git mv` umbenennen, Original danach weg) steht noch aus.
- **Nicht geprüft:** Die Tests wurden für dieses Kapitel nicht ausgeführt. Die Angaben „bestanden“ aus den Entwickler-Berichten sind nicht nachgeprüft.
