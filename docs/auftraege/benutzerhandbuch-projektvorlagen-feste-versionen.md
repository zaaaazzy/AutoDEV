# Benutzerhandbuch: Projektvorlagen mit festen Versionen und ohne Install-Skripte

Dieses Kapitel beschreibt, was sich beim Anlegen eines Projekts mit einer Vorlage aus dem Projekt-Assistenten geändert hat
(Auftrag 33c10d18, Sprint 23). Die Technik steht in [Projektvorlagen mit festen Versionen](projektvorlagen-feste-versionen-ohne-install-skripte-2026-10-27.md).

## 1. Was sich für dich ändert

- **Gleiche Vorlage, gleiche Versionen:** Die Generatoren (Vite, Angular CLI, create-next-app, nuxi, NestJS CLI) laufen mit
  festen Versionen. Zwei Projekte aus derselben Vorlage bekommen dieselben Generator-Stände, auch wenn zwischen ihnen
  neue Versionen erschienen sind.
- **Keine Install-Skripte fremder Pakete:** Die Installationen laufen mit `--ignore-scripts`. `postinstall`-Skripte von
  Paketen werden nicht ausgeführt.
- **Kein Nuxt-`prepare` mehr beim Anlegen:** Bei Nuxt-Projekten entsteht die `.nuxt/`-Typisierung erst beim ersten
  `npm run dev` oder `npm run build`.

Die Oberfläche ändert sich nicht. Die Karten im Projekt-Assistenten, die Eingabefelder und die Schritte bleiben gleich.

## 2. Wo es gilt, und wo nicht

**Gilt für:** das Anlegen eines Projekts über den Projekt-Assistenten mit einer Vorlage, die Installationsbefehle hat
(z. B. **Node.js API (TypeScript)** und **Browser-Spiel (Phaser 3)**, ebenso die übrigen Vorlagen mit Generatoren).

**Gilt nicht für:**

- die Vorlage **Leer**: Sie hat keine Befehle, es wird nur README und `.gitignore` angelegt.
- Befehle, die du später selbst im Projekt ausführst. Dein `npm install` im Terminal bleibt unverändert.
- Agents: Für sie gelten die Regeln aus [Dashboard und Agents](benutzerhandbuch-dashboard-agents.md). Sie dürfen Pakete nur mit
  `npm install|ci --ignore-scripts` installieren.

## 3. Die festen Versionen

| Generator | Version | Verwendet in |
|---|---|---|
| `create-vite` | 7.0.0 | Vite-Vorlagen |
| `@angular/cli` | 20.3.40 | Angular-Vorlagen |
| `create-next-app` | 15.5.0 | Next.js-Vorlagen |
| `nuxi` | 3.25.1 | Nuxt-Vorlagen |
| `@nestjs/cli` | 11.0.7 | NestJS-Vorlagen |

Die Vorlagen nutzen keinen `@latest`-Tag mehr. Eine neue Version ist eine Änderung am Code (`GENERATORS` in
`src/setup/templates.ts`), keine Einstellung im Assistenten.

## 4. Wie die Befehle laufen

| Vorgang | Befehl | Bedeutung für dich |
|---|---|---|
| Vorlage mit eigenem Paketinstallieren | `npm install --ignore-scripts` | Pakete werden installiert, ihre Install-Skripte nicht |
| Generator, der sonst selbst installiert | `--skip-install` bzw. `--no-install` | Der Generator installiert nichts, danach folgt der eigene `npm install --ignore-scripts` |
| Zusätzlich für alle Vorlagen-Befehle | `npm_config_ignore_scripts=true` | Auch Install-Skripte, die ein Befehl selbst anstößt, bleiben aus |

Git- und GitHub-Aufrufe sind davon nicht betroffen.

**Wichtig:** Der Generator selbst (z. B. `npm create vite`) läuft weiterhin mit den Rechten des Workers auf deinem Rechner.
Nur die Install-Skripte fremder Pakete entfallen.

## 5. Bedingungen und Grenzen

- **Bestehende Projekte** bleiben unverändert. Die Änderung wirkt nur beim Anlegen eines neuen Projekts.
- **Vorlage mit Install-Skript:** Braucht ein Paket seinen `postinstall`, um zu funktionieren, meldet der erste Start einen
  Fehler, oder das Paket fehlt zur Laufzeit. Dann führst du in deinem Projektordner `npm rebuild <paket>` aus. Das ist ein
  gewöhnlicher npm-Schritt, den AIdeation nicht automatisch macht.
- **Nuxt:** Bis zum ersten `npm run dev` oder `npm run build` fehlen die Typen. Das ist erwartet und kein Fehler.
- **Phaser-Vorlage:** Der Chromium-Download für den Playwright-Smoke-Test ist kein Install-Skript. Er läuft wie bisher, wenn
  Chromium in der passenden Version noch fehlt.

## 6. Meldungen und was du tust

| Meldung oder Zustand | Ursache | Was du tust |
|---|---|---|
| „`<Befehl>` ist fehlgeschlagen.“ | Der Befehl ist mit der festen Version oder ohne Install-Skript nicht durchgelaufen, z. B. weil eine Version in der Registry fehlt | Lies die letzten Zeilen der Ausgabe, die der Schritt anzeigt. Liegt die Ursache in einer festen Generator-Version, ist das ein Fehler im Code und kein Fehler in deinem Projekt. Melde ihn als Bug. |
| Projekt startet nach dem Anlegen nicht, Fehler wie „Cannot find module …“ | Ein Paket braucht seinen `postinstall` | `npm rebuild <paket>` im Projektordner ausführen, dann `npm run dev` |
| Nuxt-Typen fehlen in der Entwicklungsumgebung | `nuxt prepare` entfällt | `npm run dev` oder `npm run build` einmal ausführen |

## 7. Prüfliste nach dem Anlegen

- [ ] Projekt mit der gewünschten Vorlage angelegt, Schritt ohne Fehler abgeschlossen.
- [ ] `npm run dev` (bzw. `npm run build`) im Projekt läuft durch.
- [ ] Bei Nuxt: nach dem ersten `dev`/`build` sind die Typen da.

## 8. Printscreens

Keine. Die Änderung betrifft nur, was beim Anlegen im Hintergrund passiert, und die Oberfläche bleibt gleich. In dieser
Sitzung lief kein Browser und keine laufende App, deshalb habe ich keine Bilder erzeugt. Die Angaben oben stammen aus dem
Quelltext (`src/setup/templates.ts`, `src/setup/setup-jobs.ts`) und aus dem Diff der Commits des Auftrags.

## 9. Offen

- Die Tests in `src/setup/setup.test.ts` sind beim Tester noch nicht gelaufen. Laut Entwickler ist `npm run typecheck` grün.
- Außer `@angular/cli@20.3.40` sind die Generator-Versionen nicht gegen die Registry geprüft (`npm view` war gesperrt).
- Eine echte Nuxt-Vorlage ist nicht angelegt und gestartet.
