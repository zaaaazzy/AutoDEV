# Risiken: Bug „CI CD nicht in Ordnung“ (Auftrag 788ec856)

Bug-Wächter, Phase pre_task, 31.10.2026. Grundlage sind die Bug-Liste im Auftrag, `.github/workflows/ci.yml` und `docker-compose.yml`. Die Tests selbst habe ich nicht ausgeführt.

## Bugs im selben Kontext

1. **„CI CD nicht in Ordnung“ (offen, critical)** ist der Auftrag selbst. Der letzte Versuch ist bei „Entwickler“ gescheitert. Die Meldung ist nur eine abgeschnittene Dateiliste. Eine Ursache wurde nie belegt.
2. **„Entwickler: Mandanten-Prüfung für alle ID-Felder per Allowlist-Test“ (offen, high).** Der Code war in Ordnung. Tester und Testlauf konnten aber keinen Befehl ausführen, deshalb war nichts belegt.
3. **„Entwickler: Folgeaufträge aus Doku-Abschnitten“ und „Bug-Kategorien mit Vorschlag, Filter und Statistik“ (offen, high).** Beide scheiterten an Meldungen wie „monthly spend limit“ und „Keine Dateien geändert“. Das sind keine Code-Fehler. Der Tester lehnte sie mit „Testlauf nicht freigegeben“ ab.
4. **„Entwickler: Abnahme für alle Umsetzungen mit einem Klick“ (offen, high).** Gleiches Muster wie unter 3.
5. **„Entwickler: Zeige Tokenstand im Dashboard“ (behoben).** Es berührte `src/api/*`, `src/core/*` und die Test-Dateien dazu.
6. **„Bug-Wächter: Angular-Builder umstellen und Versionen angleichen“ (behoben).** Dockerfile, CI und Skripte müssen dieselbe Version und denselben Builder nutzen. Der Build gab drei Warnungen aus (NG8113, NG8107, Startgrösse 1.06 MB über 950 kB). Ob sie schon vor der Umstellung bestanden, wurde nicht geprüft.
7. **„Bug-Wächter: Review-Box und doppelte Anzeige-Helfer“ (behoben).** Der Lauf zeigte 1833 bestandene Tests. Die Specs liefen nachweislich mit.

## Was sich wiederholt hat

- **Der Testlauf wird als „grün“ oder „rot“ gemeldet, ohne dass er lief.** Die Sandbox konnte `npm run test:unit` nicht starten. Der Auftrag wurde wegen „nicht belegt“ abgelehnt. Das Wächter-Hook sperrt zusätzlich einzelne Befehle (z. B. `sed`, escapte Anführungszeichen).
- **Provider- und Limit-Meldungen wurden als Bug-Text gespeichert.** Sie sind kein Code-Fehler. Nicht beheben, sondern verwerfen.
- **Der ganze Lauf `npm run test:unit` in einem Schritt.** Er hat den Entwickler-Schritt gesprengt (Zeit- oder Freigabegrenze). Besser zuerst gezielt die betroffenen Test-Dateien starten, den Gesamtlauf getrennt.
- **Umstellung der Docker-Container (Verdacht aus dem Auftrag).** Im Compose-Setup liegt `node_modules` in einem eigenen Volume (`aideation_worker_modules`), das der Dienst `worker-volumes` per `chown` dem Worker-Benutzer übergibt. Ein leeres oder falsch besessenes Volume lässt Tests lokal scheitern, die in GitHub Actions grün sind (dort gilt `npm ci`).

## Was nicht wiederholt werden darf

1. **Nicht raten, welche Ebene kaputt ist.** Erst klären, ob der rote Lauf in GitHub Actions oder im Worker-Container auftritt. Beide Umgebungen sind verschieden (`npm ci` mit `.nvmrc` gegen Volume-`node_modules`).
2. **Den Bug nicht schliessen, solange kein grüner Lauf belegt ist.** Der Hinweis vom 30.10. verlangt einen grünen GitHub-Actions-Lauf. Ausgabe oder Job-Link an den Auftrag hängen.
3. **Das Log des roten Laufs zuerst lesen.** Die erste fehlschlagende Test-Datei bestimmt die Ursache. Danach keine Dateien auf Verdacht ändern.
4. **Keine Zufallsänderungen an vielen Dateien.** Frühere Versuche änderten ca. 20 Dateien aus `src/api`, `src/core`, `src/agent` und `scripts/`. Das macht die Ursache unlesbar und das Ende schwer zu prüfen.
5. **Die Regeln aus `CLAUDE.md` einhalten.**
   - Status-Werte aus `src/core/status.ts` beziehen.
   - Keine `x!`-Assertions.
   - Neue Dateien aus `src/core`, die das Frontend nutzt, in `frontend/tsconfig.app.json` und `frontend/tsconfig.spec.json` eintragen. Fehlt das, kann `typecheck` oder der UI-Build brechen.
6. **Wenn der Befehl nicht startet:** das im Bericht offen sagen („nicht ausgeführt“). Nicht „bestanden“ schreiben.
7. **Docker-Ursache mit dem Volume prüfen**, bevor Code geändert wird. Image `aideation-agent` neu bauen und das Volume `aideation_worker_modules` befüllen (`worker-volumes`, danach `npm ci`). Erst dann `npm run test:unit` im Container ausführen.

## Vorgehen für den Entwickler

1. Roten GitHub-Actions-Lauf öffnen und die erste fehlgeschlagene Test-Datei notieren.
2. Dieselbe Datei im Arbeitscontainer einzeln laufen lassen, danach `npm run test:unit`.
3. Ursache getrennt behandeln: Code (Test oder Produktionscode), Abhängigkeiten (`package-lock.json`, Node-Version aus `.nvmrc`) oder Volume und Image.
4. Am Ende `npm run lint && npm run format:check && npm run typecheck && npm run test:unit` ausführen und die echte Ausgabe in den Bericht übernehmen.
