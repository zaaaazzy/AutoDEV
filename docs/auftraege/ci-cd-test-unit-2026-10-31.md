# Bug „CI CD nicht in Ordnung“ (Auftrag 788ec856) – 31.10.2026

Entwickler, Phase while_task. Grundlage: `docs/risiken/ci-cd-test-unit-2026-10-31.md`.

## Merge von `sprint/sprint-30`

Beide Seiten hatten unabhängig dasselbe Problem gelöst: Das `node_modules`-Volume im Agent-Container war leer
(`tsc`/`tsx: not found`). Der Auftrags-Branch füllte es mit `npm ci` (`installModules`, `modulesInstallArgs`,
`lockfileHash`), Sprint 30 mit `npm install` unter `flock` (`ensureDependencies`, `dependencyCommand`). Beide schreiben
denselben Stempel `node_modules/.aideation-lock`, aber in verschiedenem Format (64 gegen 16 Zeichen). Zusammen hätte
jeder Lauf den Stempel des anderen ungültig gemacht und neu installiert.

- `src/core/sandbox.ts`: Weiter gilt nur der Weg aus Sprint 30, denn `workbench.ts` nutzt ihn mit. Die `npm ci`-Befüllung
  des Auftrags-Branches ist entfernt. Aus dem Auftrags-Branch übernommen: `replaceLinkedModules` ersetzt den Symlink nur
  in einem Git-Worktree (`.git` ist eine Datei). Projektordner der Menschen bleiben unberührt.
- `src/core/sandbox.test.ts`: Die Tests aus Sprint 30 sind übernommen, dazu der Test „Projektordner der Menschen“ (jetzt
  gegen `replaceLinkedModules`). `linkedWorktree` legt dafür eine `.git`-Datei an. Die `npm ci`-Tests sind entfallen.
- `src/runner/agent-workspace.ts`: Der Merge hatte ohne Konflikt eine Zeile übernommen, die jeden leeren
  `node_modules`-Ordner löschte, also auch mit Sandbox. Damit war die Sperre aus Sprint 30 wirkungslos, die den
  Mountpunkt laufender Container schützt. Die Zeile und der Helfer `isEmptyDirectory` sind entfernt.
- `deploy/agent/Dockerfile`: `rm -rf /home/agent/.npm` und `ENV npm_config_cache=/tmp/npm-cache` beibehalten.
- `scripts/angular-builder.test.ts`: Es gilt ein einziger Typ `AngularJson`. Alle `readJson`-Aufrufe sind typisiert
  (`PackageJson` mit `engines`, `PackageLock`).
- `docs/ci.md`, `docs/agents-und-rechte.md`: Der Abschnitt zur Abdeckung stammt aus Sprint 30. Die Befüllung des Volumes
  ist auf `ensureDependencies`/`replaceLinkedModules` angepasst.

## Ursache des roten `test:unit` im Agent-Container

Der Gesamtlauf schlug mit genau einem Test fehl:
`src/core/git-guard.test.ts:92` („Filter aus .git/config läuft beim git add des Workers nicht …“):

```
fatal: gitfile does not point to a valid repository: /workspace/.git
```

`plantFilter` rief `git config --file …` ohne `cwd` auf. git sucht dann ein Repository ab dem Arbeitsordner des
Testlaufs. Im Agent-Container ist `/workspace/.git` eine Datei, die auf einen Pfad des Hosts zeigt, den es im Container
nicht gibt. Darum bricht git ab. In GitHub Actions ist `/workspace` ein echter Checkout, dort tritt der Fehler nicht
auf. Fix: Der Aufruf läuft jetzt im Test-Repo (`cwd: workTree`) mit der neutralen git-Umgebung `PLAIN_ENV`, wie die
übrigen git-Aufrufe der Datei.

## Prüfung (im Arbeitscontainer, 31.10.2026)

- `npm run lint`: 0 Fehler, 722 Warnungen (bestehende `x!`-Warnungen, v. a. in `e2e/`).
- `npm run format:check`: alle Dateien in Ordnung.
- `npm run typecheck`: ohne Fehler.
- `npm run test:unit`: 2084 Tests, 2074 bestanden, 0 fehlgeschlagen, 10 übersprungen (Datenbank-Tests, weil
  `DEV_LOG_TEST_ADMIN_DATABASE_URL` fehlt). Vor dem Fix: 1 fehlgeschlagen (`git-guard.test.ts:92`).

## Nicht ausgeführt

- Den roten GitHub-Actions-Lauf konnte ich nicht lesen: `gh` ist für Agents gesperrt, und es gibt keinen Netzzugriff.
  Ob dort derselbe Test scheitert, ist darum nicht belegt.
- Einzelne Test-Dateien (`npx --no-install tsx --test <datei>`) brauchten eine Freigabe, die nicht erteilt war. Darum lief
  nur der Gesamtlauf.
- Kein Image-Neubau von `aideation-agent` und kein Befüllen des Volumes: `docker build` ist für Agents gesperrt.
- Der Bug gilt erst nach einem grünen GitHub-Actions-Lauf (Jobs `check` und `docker`) als behoben.

## Nachtrag 11.11.2026: zweiter Merge von `sprint/sprint-30`

Der Merge in den Sprint war fehlgeschlagen, weil es in `src/core/sandbox.ts` einen Konflikt gab. In Sprint 30 sind
Konstanten, Hilfen und Netzwerk nach `src/core/sandbox-base.ts` gewandert. So kann `workbench.ts` sie ohne
Import-Zyklus nutzen, und `sandbox.ts` reicht sie mit `export * from './sandbox-base.js'` weiter. Der Auftrags-Branch
hatte im alten Block von `sandbox.ts` nur einen Kommentar zu `npm_config_cache` ergänzt und dabei die Zeile
versehentlich verdoppelt.

- `src/core/sandbox.ts`: Hier gilt die Seite von Sprint 30. Der alte, doppelte Block ist entfernt.
- `src/core/sandbox-base.ts`: Der Kommentar, warum der npm-Cache in `/tmp` liegt, ist übernommen, die Zeile steht nur
  einmal.

Prüfung im Arbeitscontainer am 11.11.2026:

- `npm run typecheck`: ohne Fehler.
- `npm run lint`: 0 Fehler, 722 Warnungen (die bestehenden). Schichten in Ordnung, keine Zyklen.
- `npm run format:check`: alles in Ordnung.
- `npm run test:unit`: **2096 Tests, 2086 bestanden, 0 fehlgeschlagen, 0 abgebrochen, 10 übersprungen.** Übersprungen
  sind nur Tests, die Docker, macOS oder Windows brauchen. Die Datenbank-Tests liefen mit.

Weiter nicht belegt: der grüne GitHub-Actions-Lauf und der Neubau des Images `aideation-agent`. Für beides fehlt Agents
die Berechtigung (`gh`, `docker build`).

### Tests und Gegenprobe

Die Gegenprobe des Testers (Stand `d95610b`) zeigte, dass zwei der drei neuen Testfälle auch ohne den Fix bestanden.
Beide waren Doppel vorhandener Tests und sind entfernt (`src/core/sandbox.test.ts`, `src/runner/agent-workspace.test.ts`;
der Cache-Fall steht im bestehenden npm-Cache-Test). Neu bleibt nur „Projektordner der Menschen (`.git` als Ordner):
`node_modules`-Symlink bleibt“; er scheitert auf dem alten Stand wie erwartet.

Zu beachten: Im Agent-Container zeigt `.git` auf einen Host-Pfad, Git-Befehle gehen dort nicht. Tests, die git
aufrufen, brauchen deshalb immer `cwd` im Test-Repo (siehe `git-guard.test.ts`).
