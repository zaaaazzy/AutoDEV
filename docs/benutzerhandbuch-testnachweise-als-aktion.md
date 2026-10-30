# Benutzerhandbuch: Offene Testnachweise unter „Aktionen“

Manchmal kann der Tester (oder der Dokumentierer) einen Test, der ein Kriterium belegt, nicht selbst ausführen. Ein Grund
kann sein, dass der Befehl für den Agent gesperrt ist. Ein anderer, dass die Gegenprobe einfach noch fehlt. Solche Lücken
gehen nicht mehr unter: Der Agent meldet sie als **Testnachweis**, und du startest den Befehl mit einem Klick als Testlauf.

## 1. Wo du offene Nachweise siehst

**Aktionen → „Rückmeldungen der Agents“.** Ein Auftrag mit offenem Nachweis steht dort als „Aktion notwendig“ mit dem
Hinweis „1 Testnachweis offen“ (bzw. „2 Testnachweise offen“). Das gilt auch, wenn der Auftrag schon erledigt ist. Die
Zahl in der Menü-Bubble „Aktionen“ zählt ihn mit.

Klappst du die Zeile auf, zeigt der Abschnitt **„Offene Testnachweise“** je Nachweis:

| Angabe | Bedeutung |
|---|---|
| Datei | Die Testdatei, z. B. `src/a.test.ts` |
| Befehl | Genau ein Befehl, z. B. `npm test -- a` |
| Grund | „Gegenprobe fehlt“ (Befehl erlaubt, Lauf steht aus) oder „Befehl für den Agent nicht freigegeben“ |

Dazu kommt, welcher Agent den Nachweis gemeldet hat. Ist der letzte Lauf rot, steht „letzter Lauf rot“ dabei.

## 2. Testlauf starten

- Klick auf **„Testlauf starten“**. Der Befehl läuft als normaler Projekttestlauf im Testcontainer, auf dem aktuellen
  Stand von `main`. Das Ergebnis steht unter **Testläufe**; der Link „Letzter Lauf“ führt direkt hin.
- **Grün:** Der Nachweis ist abgehakt und verschwindet aus „Aktionen“.
- **Rot:** Der Nachweis bleibt sichtbar. Prüfe den Lauf, lass den Fehler beheben und starte erneut.
- Der Knopf ist gesperrt, solange ein kompletter Test (oder ein anderer Nachweis-Lauf) des Projekts läuft.
- Den Knopf siehst du nur mit dem Recht, Agents und Tests zu starten (`run`). Ohne dieses Recht frag einen Admin.
- Es startet nie etwas von selbst. Jeder Lauf braucht deinen Klick.

## 3. Wenn der Befehl nicht freigegeben ist

Hat der Agent den Grund „nicht freigegeben“ gemeldet, gibt es keinen Startknopf. Dasselbe gilt, wenn AIdeation den Befehl
nicht als sicheren Einzelbefehl erkennt (z. B. `npx --no-install tsx --test …`, Verkettungen oder Variablen). Stattdessen
steht dort der Link **„Rechte-Gruppen des Agents … anpassen“**. Er öffnet **Einstellungen → Rechte-Kategorien** (nur für
Admins).

- Gib dort den passenden Befehl frei oder lege ihn als `npm run …`-Skript im Projekt an. Weise die Gruppe dann unter
  **Agents** dem Agent zu.
- Danach meldet der Tester im nächsten Lauf den Nachweis mit einem erlaubten Befehl neu.
- Agents erteilen sich selbst keine Freigaben.

## 4. Was sich nicht ändert

- Offene Nachweise blockieren weder den Autopilot noch den Sprintabschluss. Sie setzen keine „Aktion“ am Auftrag.
- Abnahmepunkte (`@@ACCEPTANCE`) und „Selbst prüfen“ funktionieren wie bisher.
- Derselbe Befehl erscheint je Auftrag nur einmal, auch wenn der Tester ihn mehrfach meldet.
- Ältere Aufträge ohne gemeldete Nachweise erscheinen nicht nachträglich.

## 5. Fehlerbehebung

| Meldung oder Zustand | Ursache | Was du tust |
|---|---|---|
| „Ein kompletter Test läuft bereits.“ | Es läuft schon ein Test des Projekts. | Warten, bis er fertig ist, dann erneut starten. |
| „Befehl nicht freigegeben – Rechte-Gruppen des Agents anpassen.“ | Der Befehl ist nicht als sicherer Einzelbefehl erlaubt. | Siehe Abschnitt 3. |
| Lauf bleibt aus, Testanfrage „fehlgeschlagen“ | Der Worker hat den Befehl vor dem Start abgelehnt oder lief nicht. | Status des Workers im Dashboard prüfen. Nach einem Update den Worker neu starten. |

## 6. Printscreens

Für dieses Kapitel fehlen noch Printscreens der Seite „Aktionen“ mit einem offenen Nachweis (mit Knopf und mit
Rechte-Link). Sie werden nachgereicht, sobald die App im Browser läuft. Diese Sitzung hatte weder Browser noch laufende
App. Die Beschreibung stammt aus dem Quelltext (`frontend/src/app/features/actions/actions.component.html`,
`src/runner/test-request.ts`).
