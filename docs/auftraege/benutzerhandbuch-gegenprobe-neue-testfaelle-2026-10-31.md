# Benutzerhandbuch: Gegenprobe der neuen Testfälle im Tester-Schritt

Gilt ab Auftrag 48c732e5-e6cf-490e-ac75-a735c5baf6bf. Betrifft Bugfix-Aufträge, das Auftragsdetail und den Testbericht. Technischer Bericht: `docs/auftraege/gegenprobe-neue-testfaelle-2026-10-31.md`.

## Was passiert

Ist der Tester-Schritt eines Bugfix-Auftrags grün, führt der Worker die im Auftrag neu hinzugekommenen Testfälle auf dem Stand **vor** dem Auftrag aus. Ein guter Test scheitert dort, denn der Fehler ist noch nicht behoben.

| Ergebnis je Testfall | Bedeutung |
| --- | --- |
| scheitert wie erwartet | Der Test belegt den Fehler. |
| besteht (Fix nicht belegt) | Der Test hätte den Fehler nie gefunden. |
| nicht auswertbar | z. B. Import- oder Kompilierfehler, Zeitüberschreitung, wackeliger Test. Weder Beleg noch Rückgabegrund. |

Besteht mindestens ein Testfall, trägt der Auftrag die Markierung **„Test belegt den Fix nicht“** und geht über den üblichen Weg für rote Tests an den Entwickler zurück (einmal je Lauf, danach Bug-Bericht).

## Wo es sichtbar ist

- Im Auftragsdetail: je Testfall Name, Datei und Ergebnis sowie die Markierung. Ein erneuter Versuch überschreibt das Ergebnis.
- Im Testbericht `docs/tests/<Lauf>/bericht.md` im Abschnitt „Gegenprobe“. Hat ein Bugfix keine neuen Testfälle, steht dort der Grund.

## Worauf zu achten ist

- Feature-Aufträge werden nicht geprüft.
- Nur `node:test`/`tsx --test` wird gefiltert. Playwright, Vitest und Jest gelten als „nicht auswertbar“.
- Ohne Testbefehle je Auftrag mit `{tests}` (Projekteinstellung) ist jeder Fall „nicht auswertbar“.
- Der Arbeitsordner bleibt unverändert, außer dem Bericht unter `docs/tests/`.
