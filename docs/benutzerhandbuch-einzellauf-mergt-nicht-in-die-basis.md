# Benutzerhandbuch: Einzellauf eines Agents mergt nicht mehr in die Basis

Dieses Kapitel beschreibt, was passiert, wenn du einen Auftrag nur von einem einzelnen Agent ausführen lässt (Einzellauf, z. B. nur der Entwickler). Betroffen ist der Auftrag 72d216b7 (Bugfix, Code-Review vom 21.10.2026).

> **Printscreens:** keine. In dieser Sitzung läuft weder die App noch eine Datenbank, und ein Einzellauf braucht einen echten Agent-Lauf (lokales Modell oder Claude-CLI). Die Beschreibung stammt aus dem Quelltext (`src/runner/runner-settle.ts`, `src/runner/git-sync/order-branch.ts`) und dem Test `src/runner/settle-merge-failure.test.ts`. Die Oberflächentexte sind nicht im Browser gegengeprüft.

---

## 1. Was sich geändert hat

Vorher wurde bei einem Einzellauf der Auftrags-Branch sofort in die Basis (`main` bzw. den Sprint-Branch) gemergt. Ohne Tester, Reviewer und Freigabe. Bei Aufträgen ohne Sprint landete der Code damit direkt auf `main`. Danach ging der Auftrag zurück auf „Geplant“ und lief den ganzen Ablauf auf schon gemergtem Code.

Jetzt gilt:

- **Commit nur auf dem Auftrags-Branch:** Die Änderungen des Einzellaufs werden committet, der Branch bleibt bestehen.
- **Basis bleibt unberührt:** `main` und der Sprint-Branch ändern sich nicht.
- **Arbeitsordner zurück auf die Basis:** Der Ordner der Menschen steht danach wieder auf der Basis, nicht auf dem Auftrags-Branch.
- **Normaler Ablauf mergt später:** Der nächste normale Lauf des Auftrags setzt denselben Branch fort. Gemergt wird erst nach Tester, Reviewer und Freigabe.

---

## 2. Bedingungen

Der Schutz greift nur unter diesen Bedingungen:

| Bedingung | Was passiert |
| --- | --- |
| Der Lauf ist ein **Einzellauf** (dem Auftrag ist ein Agent zugewiesen) | Die Änderungen werden nur committet, nicht gemergt. |
| Der Agent hat **erfolgreich** gearbeitet | Nur dann wird committet. Scheitert der Lauf, gilt der normale Fehlerweg (siehe Abschnitt 3). |
| Der Auftrag hat einen **Auftrags-Branch** (Projekt mit Git-Ordner, und ein Agent hat Dateien geändert) | Der Branch wird angelegt oder fortgesetzt. |
| Es gibt **keine zurückgehaltenen Dateien** (Dateien, die nach Zugangsdaten aussehen) | Sonst wird ebenfalls nicht gemergt. Die Meldung nennt die Dateien. |
| Es sind **keine Änderungen** da | Der Lauf gilt trotzdem als erfolgreich. Der Branch bleibt, es gibt nichts zu committen. |

Wichtig:

- **Die Review-Freigabe des Projekts gilt bei einem Einzellauf nicht.** Sie wird nur im normalen Ablauf angewandt. Ein Einzellauf wird also nie „Wartet auf Freigabe“, sondern bleibt einfach ungemergt.
- **Projekte ohne Git-Ordner** bekommen keinen Auftrags-Branch. Dort wird nichts in eine Basis gemergt. Ist dem Auftrag ein Sprint zugeordnet, committet der Weg über `commitTaskToGit` auf den gerade ausgecheckten Stand. Dieses Verhalten ist für Projekte ohne Git nicht gesondert getestet (siehe Abschnitt 6).

---

## 3. Was du siehst

| Ausgang eines Einzellaufs | Status des Auftrags danach | Was du im Worker-Log findest |
| --- | --- | --- |
| Erfolgreich, Änderungen committet | Der vorherige Status (z. B. „Geplant“ oder der Status vor dem Start). Blieb der Auftrag „Abgelehnt“ oder „Backlog“, bleibt dieser Status. | „Auf <Branch> committet – Einzellauf, wird erst im normalen Ablauf in <Basis> gemergt.“ |
| Erfolgreich, keine Änderungen | Wie oben. | „Keine neuen Änderungen auf <Branch> – Einzellauf, wird erst im normalen Ablauf in <Basis> gemergt.“ |
| Fehlgeschlagen | „Blockiert“. Der Zwischenstand wird als WIP-Commit auf dem Auftrags-Branch gesichert. | Die Fehlerausgabe des Agents. |
| Zurückgehaltene Zugangsdaten | „Blockiert“, nicht gemergt. Der Auftrag bekommt den Vermerk „Fehler“ und die Aufgabe „Aktion notwendig“. Die Meldung nennt die Dateien und den Schritt „Erneut versuchen“. | Die Liste der Dateien. |

Hinweise:

- Ein Einzellauf setzt **keinen** Vermerk „Fehler“ am Auftrag und **keinen** Verweis auf einen Commit (`git_commit`). Beides wäre irreführend, weil nichts in die Basis gelangt ist.
- Bleibt der Auftrag nach dem Einzellauf auf „Geplant“, startet er mit dem nächsten normalen Lauf (Sprint oder Einzelstart für den vollen Ablauf). Dann wird der Auftrags-Branch samt Commit weiterverwendet.

---

## 4. Bedienung

1. Den Auftrag einem einzelnen Agent zuweisen (z. B. nur den Entwickler) und ihn starten. Der Status wird dabei nicht manuell geändert.
2. Warten, bis der Lauf endet. Das Ergebnis steht im Auftrag und im Worker-Log.
3. Einen Einzellauf prüfen: Im Projektordner sollte `main` unverändert sein. Der Auftrags-Branch enthält den Commit des Einzellaufs.
4. Soll der Auftrag vollständig umgesetzt und geprüft werden, den normalen Ablauf starten (Sprint oder Auftrag ohne Einzelzuweisung). Erst dort wird gemergt.

Die genaue Beschriftung der Schaltfläche zum Zuweisen und Starten eines einzelnen Agents habe ich in der Oberfläche nicht nachgeprüft.

---

## 5. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Nach einem Einzellauf steht `main` auf einem neuen Commit | Sollte mit dieser Änderung nicht mehr vorkommen. Den Commit im Log des Auftrags suchen und den Entwickler informieren. |
| Der Auftrags-Branch ist nach dem Einzellauf noch da | Erwartet. Er wird im normalen Ablauf weiterverwendet und nach der Freigabe gelöscht. Wird der Auftrag nie normal gestartet, bleibt der Branch liegen. |
| Auftrag ist nach einem Einzellauf „Blockiert“ | Der Lauf ist fehlgeschlagen. Die Fehlerausgabe im Auftrag lesen, den Fehler beheben, dann erneut starten. |
| Meldung „Arbeitsordner steht auf … statt auf …“ | Jemand hat den Branch im Ordner gewechselt. Nichts wurde committet. Den Ordner auf die Basis (`main`) zurückschalten und den Auftrag erneut starten. |
| Meldung mit „zurückgehaltenen“ Dateien | Testwerte als solche markieren („dev-log: testwert“) oder echte Schlüssel aus dem Code entfernen. Danach „Erneut versuchen“. |

---

## 6. Noch offen

- **Test nicht gegen den alten Code gelaufen.** Der Test `src/runner/settle-merge-failure.test.ts` (Einzellauf: `main` bleibt unverändert) prüft den neuen Weg. Ob er ohne die Änderung scheitert, ist nicht bestätigt. Das soll der Tester über `npm test` prüfen.
- **Tests in dieser Sitzung nicht ausgeführt.** Die Angabe „1566/1566 grün“ stammt aus dem Entwicklerbericht.
- **Projekte ohne Git-Ordner.** Der Weg über `commitTaskToGit` committet auf den gerade ausgecheckten Stand, ohne Merge. Ob das in diesem Fall gewünscht ist, ist nicht geklärt.
- **Fundstelle im Auftrag veraltet.** Der Auftrag nennt `runner-steps.ts:903-906`. Die Datei hat nur 528 Zeilen. Die Logik liegt in `src/runner/runner-settle.ts` (Zeilen 135–150) und `src/runner/git-sync/order-branch.ts` (Parameter `keep`, Zeile 222).
- **Die Entwicklerdoku** `docs/einzellauf-mergt-nicht-in-die-basis-2026-10-25.md` und der Absatz „Sperre und Parallelität“ in `docs/laufzeit.md` beschreiben dasselbe Verhalten. Dieses Kapitel ist die Anleitung für Nutzer.
