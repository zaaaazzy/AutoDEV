# Benutzerhandbuch: Kopfzeilen-Chip zeigt „Sprint pausiert“

Stand: 29.10.2026. Auftrag 921801de (Bugfix) „Kopfzeilen-Chip meldet ‚Sprint läuft ▶‘, obwohl der Sprint pausiert ist“. Grundlage: `docs/kopfzeilen-chip-sprint-pausiert-2026-10-29.md`.

---

## 1. Was sich ändert

Pausierst du den aktiven Sprint, zeigt der Sprint-Chip in der Kopfzeile jetzt das Symbol **⏸** und ist gedämpft grau. Früher stand dort weiter ▶ mit „Sprint läuft“, obwohl der Worker nichts mehr startete.

Es kommen keine neuen Schaltflächen dazu. Pausieren und Fortsetzen funktionieren wie bisher.

---

## 2. Wo du pausierst und fortsetzt

- **Pausieren:** In der Sprint-Ansicht, bei dem aktiven Sprint, über die Schaltfläche **Pausieren**. Sie erscheint nur, wenn der Sprint aktiv ist und noch nicht pausiert ist. Du brauchst das Recht „Ausführen“. Ohne das Recht fehlt die Schaltfläche.
- **Fortsetzen:** Ist der Sprint pausiert, steht oben in der Sprint-Ansicht der Hinweis **„⏸ Sprint pausiert“** (mit „von <Name>“, wenn bekannt) und die Schaltfläche **Fortsetzen**.
- Der Hinweis erklärt dir, was passiert: Laufende Agents beenden ihren Schritt. Danach startet kein weiterer Agent und kein neuer Auftrag. Angefangene Aufträge machen nach dem Fortsetzen beim nächsten Agent weiter.

---

## 3. Die Zustände des Chips

Gezeigt wird immer der erste passende Zustand in dieser Reihenfolge:

| Rang | Situation | Symbol | Text (Screenreader und Kopfzeile) |
|---|---|---|---|
| 1 | Der Sprint ist fertig | ✓ | siehe Hinweis unten |
| 2 | Worker offline | ■ | „Sprint gestoppt: Worker offline“ |
| 3 | Sprint pausiert | ⏸ | „Sprint pausiert“ |
| 4 | Ein Auftrag ist blockiert, oder sein letzter Lauf ist fehlgeschlagen | ! | „Sprint läuft mit Fehlern“ |
| 5 | Sonst (läuft oder wartet) | ▶ | „Sprint läuft“ |

Zu beachten:
- **Der Chip gilt nur für den aktiven Sprint.** Ein geplanter, abgeschlossener oder abgebrochener Sprint hat keinen Chip in der Kopfzeile.
- **Pause gewinnt gegen „mit Fehlern“.** Ein pausierter Sprint mit blockiertem Auftrag zeigt „Sprint pausiert“.
- **Worker offline gewinnt gegen Pause.** Dann siehst du „gestoppt“, weil das die dringendere Meldung ist.
- **Ein laufender Agent ändert die Anzeige nicht.** Solange der Sprint pausiert ist, zeigt der Chip ⏸, auch wenn gerade noch ein Agent arbeitet.
- **Der pausierte Chip blinkt nicht.** Nur der laufende Zustand (▶) blinkt.
- Der Text „Sprint pausiert“ ist für Screenreader und im Tooltip-Text hinterlegt. Sichtbar ist im Chip das Symbol ⏸ mit der gedämpften Farbe.

---

## 4. Beispiel

1. Der Sprint läuft. Der Chip zeigt ▶ und „Sprint läuft“.
2. Du klickst in der Sprint-Ansicht auf **Pausieren**. Der Chip zeigt ⏸ in Grau. Ein Agent, der gerade noch arbeitet, ändert daran nichts.
3. Du klickst auf **Fortsetzen**. Der Chip zeigt wieder ▶ mit „Sprint läuft“, oder ! mit „Sprint läuft mit Fehlern“, wenn ein Auftrag blockiert ist.

---

## 5. Fehlerbehebung

| Problem | Was tun |
|---|---|
| Chip zeigt ⏸, obwohl du fortgesetzt hast | Kurz warten oder die Seite neu laden. Nach „Fortsetzen“ lädt die Oberfläche die Daten neu. Bleibt ⏸ stehen, prüfe, ob der Sprint noch pausiert ist (Hinweis oben in der Sprint-Ansicht). |
| Chip zeigt ■ „gestoppt“ statt ⏸ | Der Worker ist offline, und das hat Vorrang. Worker starten. Danach erscheint ⏸, falls die Pause noch gesetzt ist. |
| Keine Schaltfläche „Pausieren“ | Du hast das Recht „Ausführen“ nicht, oder der Sprint ist nicht aktiv oder schon pausiert. |

---

## 6. Für Entwickler

- Logik: `frontend/src/app/core/nav-counts.ts` (`sprintHealthOf`, `sprintStateOf`). Aufgerufen aus `frontend/src/app/app.component.ts` (`sprintHealth`, `sprintState`).
- Darstellung: `frontend/src/app/app.component.html` (Pill in der Kopfzeile und Handy-Chip), `frontend/src/styles/02-layout.css` (Klasse `state-paused`).
- Hinweis hinter dem Pausieren: `frontend/src/app/features/sprints/sprint-detail.component.html` (Banner und Schaltflächen). Die Berechtigung kommt aus `frontend/src/app/features/sprints/sprint-actions.ts`.
- API: `src/api/sprints.ts` setzt `paused_at` beim Pausieren und beim Fortsetzen auf NULL.
- Tests: `frontend/src/app/core/nav-counts.spec.ts`.

---

## 7. Offen und nicht geprüft

- **Keine Printscreens.** Dafür muss die App mit Datenbank und Worker laufen. Ich habe sie nicht gestartet und keine Bilder erfunden.
- **Browser-Prüfung steht aus:** Sprint pausieren, Kopfzeile und Handy-Ansicht ansehen, danach fortsetzen.
- **Tests:** Der Entwickler hat sie gemeldet. In diesem Kapitel habe ich sie nicht erneut ausgeführt.
- **Fertig-Zustand (✓):** Das Symbol kommt aus `sprintStateOf`. Der Text im aria-label kommt aus `sprintHealthOf`, und dort gibt es keine Prüfung auf „fertig“. Bei einem fertigen Sprint kann der Screenreader deshalb „Sprint läuft“ vorlesen. Das ist ein Widerspruch zum Symbol, den ich nicht behoben habe. Die Tabelle nennt nur das Symbol für diesen Fall.
