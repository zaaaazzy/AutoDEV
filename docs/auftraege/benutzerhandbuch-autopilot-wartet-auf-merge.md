# Benutzerhandbuch: Sprint „Wartet auf Merge“

Dieses Kapitel beschreibt den Sprint-Zustand **„Wartet auf Merge“** (`awaiting_merge`). Er entsteht, wenn ein Sprint abgeschlossen ist, aber noch nicht in `main` steht. Auslöser ist der Bugfix 75b989ac (Code-Review vom 21.10.2026, Sprint 23): Der Autopilot startete den nächsten Sprint vom alten `main`, obwohl der vorige Sprint dort noch fehlte.

> **Printscreens:** keine. In dieser Sitzung gab es keinen Browser und keine laufende App. Die Beschreibung der Oberfläche stammt aus den Templates (`frontend/src/app/features/sprints/sprints.component.html`, `sprint-detail.component.html`, `frontend/src/app/features/runs/wait-status.ts`). Für Aufnahmen müssten App, Datenbank und Worker laufen.

---

## 1. Was sich geändert hat

Vorher: Ein abgeschlossener Sprint bekam auch dann den Stand „fertig“, wenn `main` im Ordner der Menschen nicht aktualisiert werden konnte. Der Autopilot startete den nächsten Sprint, und der lief ohne den Code des vorigen.

Jetzt gibt es einen eigenen Zustand. Solange ein Sprint nicht in `main` ist, bleibt er auf „Wartet auf Merge“. Der Autopilot startet dann keinen neuen Sprint.

## 2. Wann ein Sprint auf „Wartet auf Merge“ steht

Alle Bedingungen müssen zutreffen:

- Der Sprint ist **abgeschlossen** (Status „completed“).
- Er wurde **direkt** abgeschlossen. Im PR-Modus gilt dieser Zustand nicht; dort wartet der Sprint auf den Pull Request (Status „Review“).
- **Eine** der beiden Bedingungen gilt:
  - Der Ordner der Menschen ist nicht auf `main`, **oder** er hat offene Änderungen an versionierten Dateien. Nicht versionierte Dateien zählen nicht.
  - Der Sprint-Branch ist (noch) nicht in `main` enthalten.

Nicht betroffen sind Sprints, bei denen das Test-Gate rot ist oder der Merge Konflikte hat. Sie bleiben auf „Gescheitert“, und der Autopilot pausiert (siehe Abschnitt 6).

## 3. Was Sie in der Oberfläche sehen

| Ort | Anzeige | Bedeutung |
| --- | --- | --- |
| Sprint-Liste, Statusspalte | Badge **„Wartet auf Merge“** (Tooltip: „Noch nicht in main – dort von Hand mergen“) | Der Sprint ist gesichert, aber nicht in `main`. |
| Sprint-Detail, oben | Kasten **„⏳ Wartet auf Merge nach `main`.“** mit der Git-Meldung | Die Meldung nennt den Befehl, mit dem Sie den Sprint übernehmen. Der Kasten sagt außerdem, dass Dev Log die Prüfung selbst übernimmt. |
| Lauf-Ansicht (Fortschrittskarte) | „Wartet auf Merge nach main“, Hinweis „dort von Hand mit git merge übernehmen“ | Dieselbe Aussage, während der Sprint läuft. |
| Autopilot-Status | **„finishing“** mit Begründung „… ist noch nicht in main – wartet auf den Merge …“ | Der nächste Sprint startet nicht, bis `main` den Sprint enthält. |

## 4. Was Sie tun müssen

Der Worker schreibt nie selbst in den Ordner der Menschen, wenn dort etwas offen ist. Deshalb übernehmen Sie den Sprint von Hand:

1. Den Sprint-Branch aus der Git-Meldung im Sprint-Detail ablesen (beginnt mit `sprint/`).
2. Im Projektordner (dem Ordner der Menschen) prüfen, dass keine Änderungen an versionierten Dateien offen sind: `git status`.
3. `main` auschecken: `git checkout main`.
4. Den Sprint-Branch übernehmen: `git merge <Sprint-Branch>`.
5. Bei Konflikten diese von Hand auflösen und committen. Der Sprint bleibt auf „Wartet auf Merge“, bis `main` den Sprint enthält.

## 5. Was danach passiert

- Beim nächsten Durchlauf der Git-Sicherung prüft Dev Log mit `git merge-base --is-ancestor <Sprint-Stand> main`, ob der Sprint in `main` ist. Ist er es, wird der Sprint **„Fertig“** (`done`). Dabei wird auch der neuere Stand von `origin/main` berücksichtigt, falls es ihn gibt.
- Danach startet der Autopilot den nächsten Sprint.
- **Wichtig:** Dieser Weg schaltet **nicht** live und fordert **keinen** Neustart an, auch wenn „AIdeation nach dem Sprint-Abschluss neu starten“ eingeschaltet ist. Das sind Aufgaben des direkten Merges durch den Worker. Wer nach einem manuellen Merge live schalten will, muss das selbst tun.
- Der Zustand hat keinen Zeitplan. Ist der Worker gerade nicht aktiv, bleibt der Sprint bis zum nächsten Durchlauf auf „Wartet auf Merge“.

## 6. Fehlerbehebung

| Meldung oder Zustand | Ursache | Was Sie tun |
| --- | --- | --- |
| „Wartet auf Merge“, obwohl Sie gemergt haben | Der Merge ist nicht in `main` gelandet (z. B. auf einem anderen Branch) oder der Worker hat noch nicht geprüft. | Im Projektordner `git merge-base --is-ancestor <Sprint-Stand> main` ausführen. Exit 0 heißt „enthalten“, Exit 1 heißt „nicht enthalten“. Bei Exit 0 wartet der Sprint nur noch auf den nächsten Durchlauf. |
| „Gescheitert“, Meldung „Ob main … enthält, liess sich nicht prüfen“ | Die Prüfung selbst hat einen Git-Fehler geliefert (z. B. unbekannter Stand). Das ist kein Warten. | Die Git-Meldung im Sprint-Detail lesen, das Repository beheben und die Git-Sicherung erneut starten. Der Autopilot pausiert, bis das geschehen ist. |
| „Autopilot pausiert: Abschluss … gescheitert (Merge/Git)“ | Ein Merge in den Ordner der Menschen ist gescheitert oder das Test-Gate war rot. | Konflikte oder Testfehler beheben, dann die Git-Sicherung erneut starten oder den Autopilot freigeben. |

## 7. Grenzen

- Der Zustand gilt nur für den direkten Abschluss, nicht für den PR-Modus.
- Dev Log merged nicht selbst in den Ordner der Menschen, wenn dort etwas offen ist. Das ist Absicht.
- Ein manueller Merge löst weder „Live schalten“ noch einen Neustart aus (siehe Abschnitt 5).

## 8. Offene Punkte

- **Keine Printscreens.** Die Oberflächentexte stammen aus dem Quelltext. Eine Sichtprüfung im Browser steht aus.
- **Tests nicht ausgeführt.** Ich habe nur den Code gelesen. Die Testangaben stammen aus dem Entwicklerbericht.
- **Erneut starten:** Die Doku nennt „Git-Sicherung erneut starten“ als Weg aus „Wartet auf Merge“ bzw. „Gescheitert“. Die Schaltfläche habe ich im Frontend nicht gefunden; ob und wo sie erscheint, muss in der Oberfläche geprüft werden.
- **Auftragsdoku:** `docs/autopilot-wartet-auf-merge-2026-10-25.md` nennt im Abschnitt „Ursache“ noch die alte Fundstelle `git-sync.ts`. Die Logik liegt in `src/runner/git-sync/sprint-sync.ts`.

## Verweise

- `docs/workflows.md` (Abschnitt „Eigener Agent-Worktree“): technische Beschreibung des Ablaufs.
- `docs/laufzeit.md`: Laufzeit und Git-Sicherung.
- `docs/autopilot-wartet-auf-merge-2026-10-25.md`: Auftragsdoku.
- `docs/benutzerhandbuch-live-schalten-pr-modus.md`: Live schalten im PR-Modus.
