# Benutzerhandbuch: Freigabe-Merge auch im eigenen Agent-Worktree und mit Ordnersperre

Dieses Kapitel beschreibt, was nach einer Freigabe passiert, wenn das Projekt einen eigenen Agent-Ordner (Worktree) hat und der Auftrag keinem Sprint angehört. Betroffen ist der Auftrag f5291510 (Bugfix, Code-Review vom 21.10.2026).

> **Printscreens:** keine. In dieser Sitzung läuft weder Browser noch App. Die Beschreibung stammt aus dem Quelltext (`src/runner/review-gate.ts`) und dem Test `src/runner/review-gate-worktree.test.ts`. Die Beschriftungen der Oberfläche sind nicht im Browser gegengeprüft.

---

## 1. Was sich geändert hat

Vorher blieb ein freigegebener Auftrag ohne Sprint oft blockiert. Der Merge wollte im Basis-Branch `main` auschecken, obwohl `main` im Ordner der Menschen schon ausgecheckt war. Die Meldung war dann „Freigabe nicht gemergt“.

Jetzt gilt:

- **Merge im Ordner der Menschen:** Ist `main` in einem anderen Worktree ausgecheckt, merged AIdeation dort hinein, statt umzuschalten. Das ist derselbe Weg wie beim Abschluss eines Sprints.
- **Ordnersperre:** Die Freigabe nimmt die Sperre des Agent-Ordners. Ein Chat oder anderer Auftrag, der gerade in diesem Ordner schreibt, hält die Freigabe an, bis er fertig ist. Danach läuft der Merge.
- **Vorschau zieht nach:** Nach einem erfolgreichen Merge zieht der Projektordner (die Vorschau, z. B. `dev-live`) auf den neuen Stand der Basis nach.

Wichtig: Der Auftrag wird nur als erledigt markiert, wenn der Commit nachweislich in der Basis steckt.

---

## 2. Bedingungen

Die Freigabe-Schritte greifen nur unter diesen Bedingungen:

| Bedingung | Warum |
| --- | --- |
| Review-Freigabe des Projekts steht auf **„nur bei Oberflächen-Änderungen“** oder **„immer“** | Bei „nie“ wird gar nicht angehalten, dann gibt es keine Freigabe. |
| Der Auftrag steht auf **„Wartet auf Freigabe“** und wurde **freigegeben** | Nur solche Aufträge werden gemergt. Andere Status bleiben unberührt. |
| Der Auftrag hat einen Auftrags-Branch und eine Basis | Fehlt eins davon, meldet AIdeation „Auftrags-Branch unbekannt – bitte erneut ausführen.“ und blockiert den Auftrag. |
| Das Projekt hat einen **eigenen Agent-Ordner** (Option „Agent-Arbeitsordner“) | Nur dann wird die Vorschau im Projektordner nachgezogen. Ohne eigenen Ordner ist der Projektordner der Arbeitsordner, und es gibt nichts nachzuziehen. |
| Die Basis darf in einem **anderen** Worktree ausgecheckt sein | Das ist der Fall, der jetzt funktioniert. Der Projektordner der Menschen muss dafür nicht frei sein. |

Die Sperre des Agent-Ordners wird nur genommen, wenn wirklich freigegebene Aufträge da sind. Ohne Freigabe passiert nichts.

---

## 3. Bedienung

1. Der Auftrag wird fertig und wartet auf Freigabe. Du bekommst die Meldung **„👀 Wartet auf Freigabe · Projekt“**.
2. Den Auftrag in der Review-Instanz ansehen und **freigeben** oder **zurückweisen**.
3. Nach der Freigabe läuft der Merge. Es gibt keine weitere Eingabe von dir.

| Ausgang | Was du siehst | Was passiert im Hintergrund |
| --- | --- | --- |
| Merge erfolgreich | „✓ Auftrag freigegeben · Projekt“ | Auftrag erledigt, Vorschau zieht nach, Branch gelöscht. |
| Merge-Konflikt mit der Basis | „↻ Merge-Konflikt wird gelöst · Projekt“ | Der Auftrag startet neu. Der Entwickler löst die Konflikte. |
| Anderer Merge-Fehler | „⚠ Freigabe nicht gemergt · Projekt“ | Der Auftrag wird **blockiert**. Die Meldung steht im Auftrag. |

---

## 4. Grenzen und Verhalten im Detail

- **Ordnersperre wartet.** Während ein anderer Lauf den Agent-Ordner hält, wartet die Freigabe. Sie bricht nicht ab und meldet keinen Fehler.
- **Konflikte werden höchstens zweimal neu versucht.** Danach bleibt der Auftrag blockiert („Freigabe nicht gemergt“). Dann musst du den Konflikt von Hand lösen und den Auftrag erneut ausführen. „Erneut versuchen“ und ein erfolgreicher Abschluss setzen den Zähler zurück: Danach gibt es wieder zwei automatische Neuversuche.
- **Nachziehen der Vorschau darf scheitern.** Scheitert das Nachziehen, bleibt der Merge gültig. Die Meldung steht nur im Log des Workers, nicht als Fehler am Auftrag. Ist die Vorschau danach nicht auf dem neuen Stand, prüfe das Log.
- **Verknüpfter Bug.** Gehört der Auftrag zu einem Bug, wird nach dem Merge `resumeBlockedByBug` aufgerufen, damit der blockierte Bug weiterläuft. Was genau dabei am Bug passiert, ist in diesem Kapitel nicht nachgelesen.
- **Keine Zwischenstände im Projektordner.** Der Merge schreibt nur, wenn die Sperre frei ist. Dadurch überschreibt er keine Dateien eines parallelen Chats.

---

## 5. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| „Freigabe nicht gemergt“ mit einer Meldung über ausgecheckte Basis | Das sollte mit dieser Änderung nicht mehr vorkommen. Tritt es doch auf, die Meldung im Auftrag lesen und den Entwickler informieren; der Fall ist im Code nicht mehr vorgesehen. |
| Auftrag bleibt lange auf „Wartet auf Freigabe“ | Ein anderer Lauf hält den Agent-Ordner. Warten oder den Lauf im Dashboard prüfen. |
| „Auftrags-Branch unbekannt – bitte erneut ausführen.“ | Dem Auftrag fehlt der Branch oder die Basis. Den Auftrag erneut ausführen lassen. |
| Vorschau ist nach der Freigabe nicht auf dem neuen Stand | Das Nachziehen ist gescheitert, der Merge war trotzdem gültig. Im Worker-Log nach dem Eintrag der Vorschau suchen. |
| Nach zwei Konflikten bleibt der Auftrag blockiert | Die Neuversuche sind aufgebraucht. Konflikte von Hand lösen, dann den Auftrag erneut ausführen. |

---

## 6. Noch offen

- **Test nicht gegen den alten Code gelaufen.** `src/runner/review-gate-worktree.test.ts` zeigt zwei Fälle: Freigabe ohne Sprint bei `main` in einem anderen Worktree, und die Vorschau auf `sprint/s1`. Ob beide Tests ohne die neue Sperre bzw. ohne das Nachziehen tatsächlich scheitern, ist nicht bestätigt. Das soll der Tester über `npm test` prüfen.
- **Tests in dieser Sitzung nicht ausgeführt.** Der Wächter blockiert `npx tsx`, `node --import tsx` und `--experimental-test-coverage`. Der Test läuft nur über `npm test`.
- **Oberflächenbeschriftungen nicht geprüft.** Die Meldungstexte oben stammen aus dem Code (Push-Nachrichten in `review-gate.ts`), nicht aus einem laufenden Stand.

---

## 7. Geänderte Dateien (Code)

- `src/runner/review-gate.ts`: `processApprovals` nimmt die Ordnersperre, `mergeApprovals` merged und zieht die Vorschau nach.
- `src/runner/review-gate-worktree.test.ts`: neuer Test mit echten Git-Worktrees.

Entwicklerdoku: `docs/freigabe-merge-agent-worktree-ordnersperre-2026-10-25.md`.
