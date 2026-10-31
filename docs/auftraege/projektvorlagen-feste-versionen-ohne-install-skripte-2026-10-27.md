# Projektvorlagen mit festen Versionen und ohne Install-Skripte

Auftrag 33c10d18 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`). Commit `5248ad7`.

## Problem

Die Vorlagen des Projekt-Assistenten riefen `npm install`, `npm create -y vite@latest`, `npx -y @nestjs/cli@latest` u. a. ohne `--ignore-scripts` und ohne feste Version auf. Eine Vorlage war nicht reproduzierbar, und `postinstall`-Skripte fremder Pakete liefen mit den Rechten des Workers. Das README sagte dagegen, Installationen liefen immer mit `--ignore-scripts`.

## Umsetzung

- **Feste Generator-Versionen** (`src/setup/templates.ts`, Konstante `GENERATORS`): `create-vite@7.0.0`, `@angular/cli@20.3.40`, `create-next-app@15.5.0`, `nuxi@3.25.1`, `@nestjs/cli@11.0.7`. Kein `@latest`/`@next` mehr. Aktualisieren: `npm view <paket> version`, Vorlage einmal anlegen und prüfen.
- **`--ignore-scripts` bei jeder Installation** (`NPM_INSTALL`, `viteCommands` und die einzelnen `npm install`-Zeilen, auch `--prefix backend|frontend`).
- **Generatoren installieren nicht selbst:** Angular CLI, create-next-app und NestJS CLI laufen mit `--skip-install`, nuxi mit `--no-install`. Danach folgt ein eigener `npm install --ignore-scripts`.
- **Umgebung für alle Vorlagen-Befehle** (`src/setup/setup-jobs.ts`): `TEMPLATE_ENV` setzt `npm_config_ignore_scripts=true`. `run()` bekommt dafür den Parameter `extraEnv`. Git- und gh-Aufrufe sind nicht betroffen.
- **Nuxt:** `nuxt prepare` (postinstall, erzeugt die `.nuxt/`-Typen) entfällt. Der erste `npm run dev` oder `npm run build` holt es nach. Das steht als Kommentar im Code.
- **Doku:** `README.md` (Abschnitt „Grenzen der Agent-Rechte“) beschränkt „`--ignore-scripts`“ auf die Agent-Rechte und beschreibt das Verhalten der Vorlagen gesondert. `docs/installation.md` hat einen neuen Absatz zu den Vorlagen.

## Tests

`src/setup/setup.test.ts`:
- Phaser-Test erwartet jetzt `--ignore-scripts` und prüft, dass `npm_config_ignore_scripts` beim Ausführen gesetzt ist.
- Neuer Test: kein `@latest`/`@next`, genaue Versionen aller Generatoren, `--ignore-scripts` bei jedem `npm install`/`ci`, `--skip-install` bzw. `--no-install` bei Generatoren, die sonst selbst installieren.

Stand der Entwicklung: `npm run typecheck` grün. Tests laufen mit `npx --no-install tsx --test src/setup/setup.test.ts`, ohne Abdeckungs-Flags (der Wächter blockiert sie). Das Ergebnis des Testers lag bei dieser Doku noch nicht vor.

## Geänderte Dateien

README.md, docs/installation.md, src/setup/setup-jobs.ts, src/setup/setup.test.ts, src/setup/templates.ts

## Worauf zu achten ist

- **Versionen ungeprüft:** Außer `@angular/cli@20.3.40` konnte keine Version gegen die Registry geprüft werden (`npm view` war gesperrt). Mit `npm view create-vite@7.0.0 version` usw. bestätigen; existiert eine Version nicht, scheitert das Anlegen der Vorlage.
- **Restrisiko:** Der Generator selbst läuft weiter mit den Rechten des Workers auf dem Host (`npm exec` führt sein Programm aus, nur Install-Skripte entfallen). Das steht so im README.
- **Nuxt:** Ohne `nuxt prepare` fehlen die Typen bis zum ersten `dev`/`build`.
- **Neue Vorlagen:** Generator-Version in `GENERATORS` eintragen, `--ignore-scripts` bzw. `--skip-install` setzen. Der Test schlägt sonst fehl.
- Agents dürfen weiter nur `npm install|ci --ignore-scripts` ausführen; die Wächter-Regeln sind unverändert.

## Sprint 23 / Anfrage-TODO

- Auftrag 33c10d18: Bugfix, umgesetzt, Typecheck grün, Dokumentation hier.
- Offen: Testlauf von `setup.test.ts` durch den Tester; Generator-Versionen gegen die Registry prüfen; Nuxt-Vorlage einmal real anlegen und `npm run dev` starten.
