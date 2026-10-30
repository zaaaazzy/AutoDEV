# Benutzerhandbuch: Offene Testnachweise unter „Aktionen“

Manchmal kann der Tester (oder der Dokumentierer) einen Test, der ein Kriterium belegt, nicht selbst ausführen. Ein Grund
kann sein, dass der Befehl für den Agent gesperrt ist. Ein anderer, dass die Gegenprobe einfach noch fehlt. Solche Lücken
gehen nicht mehr unter: Der Agent meldet sie als **Testnachweis**, und du startest den Befehl mit einem Klick als Testlauf.

## 1. Wo du offene Nachweise siehst

**Aktionen → „Rückmeldungen der Agents“.** Ein Auftrag mit offenem Nachweis steht dort als „Aktion notwendig“ mit dem
Hinweis „1 Testnachweis offen“ (bzw. „2 Testnachweise offen“). Das gilt auch, wenn der Auftrag schon erledigt ist und
auch dann, wenn er sonst keine Aktion braucht. Die Zahl in der Menü-Bubble „Aktionen“ zählt ihn mit.

Klappst du die Zeile auf, zeigt der Abschnitt **„Offene Testnachweise“** je Nachweis:

| Angabe | Bedeutung |
|---|---|
| Datei | Die Testdatei, z. B. `src/a.test.ts` (sonst „(ohne Datei)“) |
| Befehl | Genau ein Befehl, z. B. `npm test -- a` |
| Grund | „Gegenprobe fehlt“ (Befehl erlaubt, Lauf steht aus) oder „Befehl für den Agent nicht freigegeben“ |

Dazu kommt „gemeldet von …“ mit dem Namen des Agents, sofern bekannt. Ist der letzte Lauf rot, steht „letzter Lauf rot“
dabei.

## 2. Testlauf starten

- Klick auf **„Testlauf starten“**. Der Befehl läuft als normaler Projekttestlauf im Testcontainer. Das Ergebnis steht
  unter **Testläufe**; der Link „Letzter Lauf“ führt direkt dorthin.
- Während der Lauf angefordert ist oder läuft, zeigt der Knopf „Testlauf läuft …“ und ist gesperrt.
- Der Lauf prüft den **aktuellen Stand von `main`**. Liegt der Projektordner als eigener Agent-Worktree vor und hat
  noch nicht eingecheckte Änderungen (ein Auftrag arbeitet gerade), bricht der Lauf mit „Offene Änderungen im
  Agent-Worktree (wartender Auftrag?) – Test auf main nicht möglich.“ ab. Warte, bis der Auftrag fertig ist, und starte
  dann erneut.
- **Grün:** Der Nachweis ist abgehakt und verschwindet aus „Aktionen“.
- **Rot:** Der Nachweis bleibt sichtbar mit „letzter Lauf rot“. Prüfe den Lauf, lass den Fehler beheben und starte erneut.
- Der Knopf ist gesperrt, solange ein kompletter Test des Projekts (oder ein anderer Nachweis-Lauf) angefordert ist
  oder läuft. Die Meldung lautet dann „Ein kompletter Test läuft – danach kannst du den Befehl starten.“
- Den Knopf siehst du nur mit dem Recht, Agents und Tests zu starten (`run`). Ohne dieses Recht fehlt er, frag einen
  Admin.
- Es startet nie etwas von selbst. Jeder Lauf braucht deinen Klick, und der Befehl kommt nur aus dem gespeicherten
  Nachweis, nicht aus dem Klick.

## 3. Wenn der Befehl nicht freigegeben ist

Hat der Agent den Grund „nicht freigegeben“ gemeldet, gibt es keinen Startknopf. Dasselbe gilt, wenn AIdeation den Befehl
nicht als sicheren Einzelbefehl erkennt (z. B. `npx --no-install tsx --test …`, Verkettungen oder Variablen). Stattdessen
steht dort der Link **„Rechte-Gruppen des Agents „…“ anpassen“**. Er öffnet **Einstellungen → Rechte-Kategorien**. Diese
Seite bearbeiten nur Administratoren.

- Lege den Befehl in einer eigenen Rechte-Kategorie an. Erlaubt sind dabei nur bestimmte Programme und Muster, z. B.
  `npm test …`, `npm run <skript> …` oder `git status|diff|log`. Andere (etwa `npx` ohne Ausnahme) bleiben gesperrt.
- Weise die Kategorie dann dem Agent zu. Die Zuweisung erfolgt beim Agent, nicht in der Kategorie.
- Danach meldet der Tester im nächsten Lauf den Nachweis mit einem erlaubten Befehl neu.
- Agents erteilen sich selbst keine Freigaben.

## 4. Was sich nicht ändert

- Offene Nachweise blockieren weder den Autopilot noch den Sprintabschluss. Sie setzen keine „Aktion“ am Auftrag.
- Abnahmepunkte (`@@ACCEPTANCE`) und „Selbst prüfen“ funktionieren wie bisher.
- Derselbe Befehl erscheint je Auftrag nur einmal, auch wenn der Tester ihn mehrfach meldet.
- Ältere Aufträge ohne gemeldete Nachweise erscheinen nicht nachträglich. Dort muss der Tester den Nachweis neu melden.

## 5. Fehlerbehebung

| Meldung oder Zustand | Ursache | Was du tust |
|---|---|---|
| „Ein kompletter Test läuft bereits.“ | Es läuft schon ein Test des Projekts. | Warten, bis er fertig ist, dann erneut starten. |
| „Befehl nicht freigegeben – Rechte-Gruppen des Agents anpassen.“ | Der Befehl ist nicht als sicherer Einzelbefehl erlaubt. | Siehe Abschnitt 3. |
| „Offene Änderungen im Agent-Worktree …“ | Ein Auftrag arbeitet gerade im Projektordner. | Warten, bis der Auftrag fertig ist, dann erneut starten. |
| Lauf bleibt aus, Testanfrage „fehlgeschlagen“ | Der Worker hat den Befehl vor dem Start abgelehnt oder lief nicht. | Status des Workers im Dashboard prüfen. Nach einem Update den Worker neu starten (Administrator). |

## 6. Printscreens (noch offen)

Für dieses Kapitel fehlen noch Printscreens. Sie wurden in dieser Sitzung nicht erstellt: Es gab keinen Browser und keine
laufende App. Bilder sind nicht erfunden. Nötig sind diese drei Aufnahmen, jeweils mit Desktop-Ansicht:

1. **Aktionen mit offenem Nachweis und Knopf** („Testlauf starten“ sichtbar, Abschnitt 1 und 2).
2. **Aktionen mit Rechte-Link** (Grund „nicht freigegeben“, ohne Knopf, Abschnitt 3).
3. **Testläufe** mit dem Ergebnis des Nachweis-Laufs (Link „Letzter Lauf“, Abschnitt 2).

Das Bild `docs/benutzerhandbuch-dashboard-agents/rechte-kategorien-uebersicht.png` ist für Abschnitt 3 **nicht**
verwendbar. Es zeigt noch die Gruppe „Docker-Dienste“, die laut `docs/agents-und-rechte.md` entfernt wurde. Die
Beschreibung stammt aus dem Quelltext (`frontend/src/app/features/actions/actions.component.html`,
`src/api/test-requests.ts`, `src/runner/test-request.ts`).
