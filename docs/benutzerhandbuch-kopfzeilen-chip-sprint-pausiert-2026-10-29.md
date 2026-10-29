# Benutzerhandbuch: Kopfzeilen-Chip zeigt „Sprint pausiert“

Stand: 29.10.2026. Auftrag 921801de (Bugfix) „Kopfzeilen-Chip meldet ‚Sprint läuft ▶‘, obwohl der Sprint pausiert ist“. Grundlage: `docs/kopfzeilen-chip-sprint-pausiert-2026-10-29.md`.

---

## 1. Was sich ändert

Pausierst du den aktiven Sprint, sagt der Chip in der Kopfzeile jetzt **„Sprint pausiert“** mit dem Symbol **⏸**. Früher stand dort weiter „Sprint läuft“ mit ▶, obwohl der Worker nichts mehr startete. Das gilt auch für den Chip in der Handy-Ansicht und für den Text, den Screenreader vorlesen.

Es kommen keine neuen Schaltflächen dazu. Pausieren und Fortsetzen funktionieren wie bisher.

---

## 2. Die Zustände des Chips

Gezeigt wird immer der erste passende Zustand in dieser Reihenfolge:

| Rang | Situation | Text | Symbol |
|---|---|---|---|
| 1 | Alle Aufträge des Sprints sind fertig | (Fertig-Zustand) | ✓ |
| 2 | Worker offline | „Sprint gestoppt: Worker offline“ | ■ |
| 3 | Sprint pausiert | „Sprint pausiert“ | ⏸ |
| 4 | Ein Auftrag ist blockiert oder sein letzter Lauf ist fehlgeschlagen | „Sprint läuft mit Fehlern“ | ! |
| 5 | Sonst | „Sprint läuft“ | ▶ |

Der pausierte Chip ist grau gedämpft und blinkt nicht.

Zu beachten:
- Pause gewinnt gegen „mit Fehlern“. Ein pausierter Sprint mit blockiertem Auftrag zeigt „Sprint pausiert“.
- Ist der Worker offline, siehst du „gestoppt“ statt „pausiert“, denn das ist die dringendere Meldung.
- Ein fertiger Sprint zeigt ✓, auch wenn die Pause noch gesetzt ist.

---

## 3. Beispiel

1. Der Sprint läuft, der Chip zeigt „Sprint läuft“ mit ▶.
2. Du pausierst den Sprint. Der Chip zeigt „Sprint pausiert“ mit ⏸. Ein Agent, der gerade noch arbeitet, ändert daran nichts.
3. Du setzt den Sprint fort. Der Chip zeigt wieder „Sprint läuft“ (oder „… mit Fehlern“).

---

## 4. Fehlerbehebung

| Problem | Ursache | Was tun |
|---|---|---|
| Chip zeigt „pausiert“, obwohl du fortgesetzt hast | Die Daten sind noch nicht neu geladen | Kurz warten oder die Seite neu laden. Nach „Fortsetzen“ lädt die Oberfläche die Daten selbst neu. |
| Chip zeigt „gestoppt“ statt „pausiert“ | Der Worker ist offline, das hat Vorrang | Worker starten. Danach erscheint „pausiert“, falls die Pause noch gesetzt ist. |

---

## 5. Für Entwickler

- Logik: `frontend/src/app/core/nav-counts.ts` (`sprintHealthOf`, `sprintStateOf`). Aufgerufen aus `app.component.ts`.
- Darstellung: `app.component.html` (Pill und Handy-Chip), `styles/02-layout.css` (`state-paused`).
- Tests: `core/nav-counts.spec.ts`.

---

## 6. Offen und nicht geprüft

- **Printscreens:** Keine. Dafür braucht es eine laufende App mit Datenbank und Worker.
- **Browser-Prüfung steht aus:** Sprint pausieren, Kopfzeile und Handy-Ansicht ansehen, danach fortsetzen.
- **Tests:** Vom Entwickler gemeldet, für dieses Kapitel nicht erneut ausgeführt.
- Das Symbol für den Fertig-Zustand und dessen genauen Text habe ich nicht im Template geprüft; die Tabelle folgt `sprintStateOf` (`done`).
