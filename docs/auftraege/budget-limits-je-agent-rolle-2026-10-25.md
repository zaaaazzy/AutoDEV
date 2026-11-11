# Budget-Limits je Agent-Rolle per API

Auftrag c6515b5a (Entwicklung, 25.10.2026). Sprint 23.

## Ziel

Administratoren lesen und ändern per API das Token-Budget je Agent-Rolle und Zeitraum (`day`, `sprint`, `order`). Der Worker prüft die Grenzen vor jedem Agent-Schritt und warnt bei 80 %. Die Projektlimits (`budgets`) bleiben unverändert, die Rollen-Limits kommen zusätzlich dazu.

## Umsetzung

- **Tabelle `budget_role_limits`** (`src/db/schema.ts`): Primärschlüssel (project_slug, role, period), `max_tokens > 0`, `role` auf die acht Agent-Rollen beschränkt (ohne `custom`). Alles mit `IF NOT EXISTS`, ein zweiter Start läuft ohne Fehler. Keine Zeile bedeutet keine Grenze.
- **Neue Spalte `development_items.budget_blocked_role`**: Rolle, deren Limit den Auftrag blockiert (`NULL` = Projektlimit). Die Freigabe prüft dasselbe Limit.
- **Neuer Index** `agent_usage_role_idx` auf `agent_usage (project_slug, role, created_at)` für die Verbrauchssumme je Rolle.
- **API** (`src/api/budget.ts`):
  - `GET /api/projects/:slug/budget/roles`: alle Rollen mit `maxTokens`, `spend` und `percent` je Zeitraum. Beim Auftragslimit ist `spend` `null`.
  - `PUT /api/projects/:slug/budget/roles/:role` (nur „admin“): Body `{ day, sprint, order }` mit `{ maxTokens }` oder `null`. `null` löscht die Zeile, ein fehlender Zeitraum bleibt unverändert. Danach werden wegen Budget blockierte Aufträge freigegeben.
  - Ungültige Rolle, Zeitraum oder Grenze (nicht positiv, keine Zahl) ergibt HTTP 400 mit deutscher Meldung, es wird nichts gespeichert.
- **Rechte** (`src/api/roles.ts`): Beschreibung der Rolle „admin“ nennt die Rollen-Limits ausdrücklich.
- **Worker** (`src/runner/budget.ts`, `runner-steps.ts`, `runner.ts`, `runner-context.ts`): `BudgetScope` hat das Feld `role`. `checkBudget` prüft zuerst das Projektlimit, dann das Limit der Rolle. `budgetGate(ctx, agent.role)` stoppt den Schritt, auch vor dem zweiten Versuch nach einem vorübergehenden Fehler. Gate, Warnung und Freigabe nutzen dieselbe Logik.
- **Warnung**: 80 % je Rolle und Zeitraum genau einmal. In `budget_warnings` steht `period_key = rolle:<role>:<key>`, die Tabelle ist unverändert.
- **Autor und Bug-Wächter** (`src/agent/requirements.ts`): prüfen ihr Rollen-Limit, weil ihr Verbrauch über `agent_usage.role` gezählt wird.
- **Sichtbarer Blockadegrund** (`src/agent/troubleshoot.ts`): Der Grund steht am Auftrag (`failure`, etwa „Tageslimit der Rolle „developer“: 600k Tokens von 500k Tokens“). Die Problemanalyse zeigt ihn als „Budget-Blockade“, auch ohne fehlgeschlagenen Schritt.

## Verbrauch je Rolle

Summe aus `agent_run_steps` (über `agent_id` → `agents.role`) und `agent_usage.role`. Schritte ohne `agent_id` (eingebaute Agents) und Schritte eines gelöschten Agents (`ON DELETE SET NULL`) zählen zu keiner Rolle, bleiben aber im Projektverbrauch. Ältere Schritte werden nicht nachträglich zugeordnet. Ein Test hält das fest.

## Geänderte Dateien

- `src/db/schema.ts`
- `src/runner/budget.ts`, `src/runner/runner-context.ts`, `src/runner/runner-steps.ts`, `src/runner/runner.ts`
- `src/api/budget.ts`, `src/api/roles.ts`
- `src/agent/requirements.ts`, `src/agent/troubleshoot.ts`
- `src/runner/budget.test.ts` (7 neue Tests), `src/api/budget.test.ts` (6 neue Tests)
- `docs/laufzeit.md` (Abschnitt „Token-Limits je Agent-Rolle“)

## Worauf zu achten ist

- Keine Oberfläche: Einstellungen, Dashboard und Statistik folgen in einem eigenen Auftrag (dort `auth.can()` nutzen).
- Nur Token-Limits, keine Kosten-Limits je Rolle. `visual_tester` und `custom` haben kein Limit.
- Wird ein Agent gelöscht, geht sein früherer Verbrauch in den Projekttopf über.
- Die Verbrauchsabfrage läuft über dieselben Tabellen wie die Projektsumme. Bei vielen Rollen den Index `agent_usage_role_idx` im Blick behalten.
- Die Tests `src/runner/budget.test.ts` und `src/api/budget.test.ts` haben nur neue Tests, keine bestehende Erwartung wurde geändert.
- Offen: Im vollen Lauf ist `src/api/app.test.ts:608` (`PATCH /development`, Sprint-Zuordnung, erwartet 400, bekommt 404) rot. Die Route wurde nicht angefasst. Ob der Test auch ohne diese Änderung scheitert, ist nicht geprüft.
- Typprüfung und Lint melden keine Fehler.
