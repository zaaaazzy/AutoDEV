# Bug-Wächter: Folgefehler des Spend-Limits (Doku an den Code angleichen)

Auftrag 6a76e586 (Bugfix). Titel: „Bug: Bug-Wächter: Doku an den Code angleichen (ERM, 2FA-Reset…“.

## Problem

- Der Bug entstand automatisch, weil der Schritt „Bug-Wächter“ des Auftrags „Doku an den Code angleichen (ERM, 2FA-Reset…)“ (59c9e471) fehlschlug.
- Der Wächter hat nie gearbeitet. Die Claude-CLI brach sofort mit „You've hit your monthly spend limit … resets 8:50pm (Europe/Zurich)“ ab. Die Meldung wurde als Bug-Text übernommen.
- Ein Doku- oder Code-Defekt liegt nicht vor. Der ursprüngliche Auftrag 59c9e471 ist mit `0d92133` gemergt.

## Umsetzung

Es wurde kein Code und keine bestehende Doku geändert. Der Entwickler hat Stichproben gegen den aktuellen Code gemacht (keine vollständige Prüfung jeder ERM-Spalte):

- ERM: `doc_revisions`, `review_slots` (Slot 1 aktiv, 2/3 aus) und `routing_rules` sind im Schema vorhanden.
- 2FA-Reset: Route `POST /users/:id/totp/reset`, nur für Admins (`src/api/users.ts:176`). Der Schlüssel `auth_totp_pending` ist in `src/api/auth.ts:26` definiert, wie in der README beschrieben.
- `DEV_LOG_BIND` kommt in `src`, `docker-compose.yml`, `README.md` und `docs/installation.md` nicht mehr vor.

Es wurden keine Tests ausgeführt, weil nichts geändert wurde.

## Geänderte Dateien

Keine. (Nur diese Dokumentation wurde ergänzt.)

## Sprint

| Auftrag | Titel | Art | Zustand |
|---|---|---|---|
| 6a76e586 | Bug-Wächter: Doku an den Code angleichen (ERM, 2FA-Reset…) | Bugfix | ohne Änderung abgeschlossen, Ursache Spend-Limit; Folgeeintrag zu 59c9e471 (`0d92133`) |

## Anfrage / TODO

- Bug als behoben bzw. Duplikat von 59c9e471 schließen, Verweis `0d92133`.
- Weiterhin offen und nicht erledigt: „CI/CD test:unit schlägt fehl“ und „Angular-Builder umstellen und Versionen angleichen“. Letzteres braucht `npm install`, das Agents nicht ausführen dürfen, also Übergabe an einen Menschen.
- Aufträge erst nach dem Reset (8:50pm Europe/Zurich) oder mit höherem Limit unter claude.ai/settings/usage neu starten.

## Technische Dokumentation

- Limit-Ausgaben („spend limit“) werden in `runner-steps.ts` und `autofix.ts` erkannt (Commit `cff88be`). Siehe die Doku zu Auftrag 15d12f5b.
- Dass trotzdem ein Bug entstand, deutet auf einen Worker mit älterem Code oder eine Lücke in der Erkennung hin. Bei Wiederholung Exit-Code aus `agent_run_steps` und Rohausgabe mitliefern.

## Worauf zu achten ist

- Vor jeder Fehleranalyse prüfen, ob der Schritt wirklich gearbeitet hat.
- Doku nur anhand des aktuellen Codes angleichen, nicht aus dem Gedächtnis.
- Limit-Meldungen gehören nicht in Bug-Texte oder „Risiken“.
