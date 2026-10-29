# Tokenstand im Dashboard (Auftrag b42e30c8, 29.10.2026)

## Problem

Hatte das Konto eines Agent-Anbieters sein Nutzungslimit erreicht („You've hit your monthly spend limit …“), war das nur in den Schritt-Protokollen sichtbar. Im Dashboard stand kein Hinweis, und es gab keinen Weg zur Bezahlseite des Anbieters.

## Lösung

- **Eine Erkennung.** Muster und `usageLimitReset` liegen jetzt in `src/core/provider-limits.ts`. `src/runner/autofix.ts` exportiert sie weiter. Pre-Sprint, Runner und die Einordnung als Agent-Fehler (kein Bug) nutzen dieselbe Funktion wie bisher.
- **Status je Anbieter.** `noteProviderOutcome` ordnet einen Lauf dem Anbieter am Programmnamen des konfigurierten Befehls zu (`claude`, `copilot`, `gemini`). Es liest den Anbieter nie aus der Ausgabe.
  - Bei Limit-Meldung: `app_settings.provider_limit:<anbieter>` = `{ since, resetAt }`.
  - Bei Erfolg: Eintrag löschen.
  - Aufgerufen wird es in `runStep` (Workflow-Schritte) und in `runAuthorAgent` (Chat, Bug-Wächter, Visionär, Analyse …). Das lokale Modell und unbekannte Programme ändern nichts.
- **Zurücksetzen.** Nach `resetAt` gilt der Eintrag als abgelaufen (Status `ok`), auch ohne neuen Lauf.
- **API** (`src/api/provider-limits.ts`):
  - `GET /api/agent-limits` liefert je Anbieter `status` (ok/limited), `since`, `resetAt`, `paymentUrl` und `actions`.
  - `actions.pay` gibt es nur bei erreichtem Limit.
  - `actions.resume` gibt es nur zusätzlich mit der Rolle „Ausführen“ und Zugriff auf alle Projekte, denn das Konto gilt für alle Projekte.
  - `POST /api/agent-limits/:provider/resume` prüft dasselbe auf dem Server (404 unbekannter Anbieter, 403 ohne Zugriff auf alle Projekte, 409 ohne Limit). Danach vergisst es das Limit und setzt `retry_after` nur bei Aufträgen zurück, deren Vermerk mit „Unterbrochen: Nutzungslimit des Agent-Kontos erreicht“ beginnt.
- **Bezahlseiten** fest im Code: Claude `https://claude.ai/settings/usage`, GitHub Copilot `https://github.com/settings/copilot`, Gemini `https://console.cloud.google.com/billing`. Links aus der CLI-Meldung werden nie übernommen. Das Frontend zeigt zusätzlich nur `https://`-Links.
- **Dashboard.** `app-provider-limit-alert` steht unter dem Git-Hinweis. Es fragt alle 60 Sekunden ab und nutzt die vorhandenen Stile von `.git-alert` (kein neues CSS, keine neuen Pakete).

## Grenzen

- Erkannt wird nur die Meldungsform der Claude-CLI („hit your … limit“). Copilot und Gemini erscheinen nur, wenn ihre CLI eine solche Meldung ausgibt.
- „Fortsetzen“ löst die Pause nur bei Aufträgen. Eine Pre-Sprint-Phase, die auf den Reset wartet (`sprints.pre_sprint_next_at`), läuft weiter zur gemeldeten Zeit.
- Ist der Befehl ein eigenes Wrapper-Skript (z. B. `run-claude.sh`), ist der Anbieter unbekannt. Der Auftrag pausiert dann wie bisher, nur der Dashboard-Hinweis fehlt.

## Tests

- `src/core/provider-limits.test.ts`: Anbieter aus dem Befehl, fester https-Link, Zurücksetzen nach Reset und Erfolg, unlesbare Einträge, „Fortsetzen“, Aktionen je Rolle und Mandant.
- `frontend/src/app/features/dashboard/provider-limits.spec.ts`: Anzeige nur bei aktivem Limit, nur `https://`, Meldungstext.
