# Benutzerhandbuch: CI-Prüfungen Lint, Format und Volume-Befüllung (Auftrag 788ec856)

Dieses Kapitel gehört zum Bugfix „CI CD nicht in Ordnung“. Es beschreibt, was du als Benutzer davon merkst, welche Prüfungen vor einem Abschluss laufen müssen und unter welchen Bedingungen der Entwickler-Agent in der Docker-Sandbox startet.

> **Printscreens:** keine. Der Fix hat keine neue Bildschirmansicht. Die Änderungen liegen in Tests, Formatierung, Dockerfile und `src/core/sandbox.ts`. In dieser Umgebung läuft kein Browser und die App wurde nicht gestartet.

> **Stand:** Nicht committet. Die Zahl „1833 von 1833 Tests bestanden“ stammt nur vom Entwickler. Der Tester konnte in der Sandbox nichts ausführen. Ein Lauf mit belegter Ausgabe und ein grüner GitHub-Actions-Lauf (Jobs `check`, `e2e` und `docker`) fehlen noch.

---

## 1. Was sich für dich ändert

| Bereich | Änderung | Auswirkung für dich |
|---|---|---|
| `scripts/angular-builder.test.ts` | Zwei `any` durch konkrete Typen ersetzt (laut Entwicklerbericht) | `npm run lint` soll grün sein. Keine Lint-Ausnahme. Nicht in dieser Sitzung ausgeführt. |
| 6 Dateien unter `frontend/src` (laut Entwicklerbericht) | Nur mit Prettier formatiert, kein Inhalt geändert | `npm run format:check` soll grün sein. Nicht in dieser Sitzung ausgeführt. |
| `deploy/agent/Dockerfile` | `/home/agent/.npm` wird nach der Installation gelöscht | Der Agent im Container kann den npm-Cache wieder beschreiben. Wirksam erst nach Neubau des Images. |
| `src/core/sandbox.ts` | Der Worker füllt das `node_modules`-Volume vor jedem Lauf selbst | Der erste Lauf im Container dauert länger. Du musst nichts von Hand tun. |

Die Oberfläche bleibt unverändert.

## 2. Welche Prüfungen vor einem Abschluss laufen

Der CI-Job `check` führt vier Befehle aus (`.github/workflows/ci.yml`). Alle vier gehören zum Abschluss eines Bugs. `test:unit` allein reicht nicht.

Im Projektordner:

```
npm run lint
npm run format:check
npm run typecheck
npm run test:unit
```

| Befehl | Was er prüft | Typischer Fehler |
|---|---|---|
| `npm run lint` | ESLint über das ganze Projekt, auch `scripts/` | `no-explicit-any` |
| `npm run format:check` | Prettier nur für `src` und `frontend/src` | Datei nicht formatiert. `npx prettier --write <Datei>` behebt das. |
| `npm run typecheck` | TypeScript für Server, Frontend, Tests | Typfehler |
| `npm run test:unit` | Alle Tests unter `src/`, `scripts/` und `frontend/src` | Testfehler |

**Bedingung für „grün“:** Alle vier Befehle enden ohne Fehler. Die Ausgabe gehört in den Bericht. Eine Zahl allein genügt nicht.

## 3. Wann der Entwickler-Agent in der Sandbox ein gefülltes Volume hat

Diese Bedingungen gelten nur, wenn die Docker-Sandbox eingeschaltet ist (`DEV_LOG_AGENT_SANDBOX=docker` oder Projektwert „Docker“). Die Schalter stehen im Handbuch der Phase 1.

| Bedingung | Was passiert |
|---|---|
| Worktree hat `package.json` und `package-lock.json` | Der Worker füllt das Volume `aideation-node-modules-<projekt>` vor dem Lauf. |
| Stempel `.aideation-lock` im Volume passt zum Lockfile | Keine Installation. Der Lauf startet sofort. |
| Lockfile hat sich geändert, oder das Volume ist leer | `npm ci --ignore-scripts` läuft in einem eigenen Container. Danach `npm rebuild esbuild`. |
| Zwei Läufe desselben Projekts gleichzeitig | Der zweite wartet auf dieselbe Installation. |
| `npm ci` schlägt fehl | Der Lauf startet nicht. Die Meldung unten erscheint. |

Vor dem Lauf ersetzt der Worker im Agent-Worktree den `node_modules`-Symlink auf den Host-Pfad durch einen leeren Ordner (`prepareModulesMountpoint`), damit das Volume dort sichtbar ist. Projektordner von Menschen bleiben unberührt. Das Log des roten GitHub-Actions-Laufs (Job `check`) liegt dem Auftrag noch nicht an. Ein Mensch muss es anhängen, weil `gh` für Agents gesperrt ist.

Der Installationscontainer sieht nur das Volume sowie `package.json`, das Lockfile und `.npmrc` (nur lesend). Den Worktree sieht er nicht.

### Meldung bei fehlgeschlagenem `npm ci`

> Sandbox: npm ci im node_modules-Volume „aideation-node-modules-<projekt>“ ist fehlgeschlagen (Exit-Code …). Der Agent wurde nicht gestartet.

**Was du tust:** Die angezeigte npm-Ausgabe lesen. Ist das Lockfile kaputt oder die npm-Registry nicht erreichbar, behebe das zuerst. Danach:

```
docker volume rm aideation-node-modules-<projekt>
```

und den Lauf erneut starten.

### Meldung bei nicht vorbereitbarem Volume

> Sandbox: node_modules-Volume „…“ liess sich nicht vorbereiten (Exit-Code …). Der Agent wurde nicht gestartet.

**Was du tust:** Die Ausgabe prüfen. Ggf. das Volume mit `docker volume rm` entfernen und neu versuchen.

## 4. Was du siehst, wenn `tsc` oder `tsx` fehlt

Die Meldung `tsc: not found` oder `tsx: not found` (Exit 127) im Agent-Container heisst: Das Volume ist leer. Das ist **kein Testfehler**. Der Code selbst ist in diesem Fall nicht geprüft.

**Was du tust:**

1. Worker mit dem neuen Code neu starten („AIdeation neu starten“). Dabei wird das Image `aideation-agent` neu gebaut.
2. Einen neuen Lauf starten. Der Worker füllt das Volume dabei.
3. Prüfungen aus Abschnitt 2 laufen lassen und die Ausgabe belegen.

Ein Agent darf in der Sandbox kein `npm install` ausführen. Der Wächter sperrt es. Das Befüllen übernimmt der Worker selbst.

## 5. Bedingungen für das Schliessen des Bugs

Der Bug 788ec856 gilt erst als behoben, wenn alle diese Punkte erfüllt sind:

1. Die vier Befehle aus Abschnitt 2 sind lokal oder im Lauf grün, mit Ausgabe.
2. Der Worker lief mit dem neuen Code, und ein Sandbox-Lauf hat das Volume gefüllt.
3. Ein GitHub-Actions-Lauf ist grün, mit den Jobs `check`, `e2e` und `docker`. Eine frühere Notiz behauptete, es gebe keinen `e2e`-Job. Das stimmt nicht: `ci.yml` definiert ihn.

Meldungen wie „monthly spend limit“ der Claude-CLI sind **keine** Code-Fehler. Sie betreffen nur das Monatslimit und dürfen nicht als Begründung für einen Bug dienen.

## 6. Grenzen und offene Punkte

- **Testzahl ungeklärt.** Der Entwickler nennt 1833. Das Benutzerhandbuch des Angular-Builder-Bugs nennt 1822. Keiner der beiden Werte ist vom Tester bestätigt.
- **`@angular-devkit/build-angular` steht noch im Lockfile.** `npm ci` scheitert deswegen nicht. Das Aufräumen braucht ein `npm install` von Hand, das für Agents gesperrt ist.
- **Keine Prüfung in dieser Sitzung.** Die Angaben zu Lint und Format stammen aus den Änderungen und aus dem Entwicklerbericht, nicht aus einem eigenen Lauf.

---

*Quelle: Auftrag 788ec856, Dokument `docs/ci-lint-und-format-fehler-788ec856-2026-10-29.md`, `src/core/sandbox.ts` (Konstante `MODULES_STAMP`, Funktion `modulesVolume`), `package.json` (Skripte). Nicht committet.*
