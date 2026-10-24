# __PROJECT_NAME__

Browser-Spiel mit [Phaser 3](https://phaser.io/), TypeScript und Vite. Die Beispielszene „Sterne sammeln“ zeigt den
Aufbau: Pfeiltasten (oder Maus/Touch gedrückt halten) bewegen die Figur, jeder Stern gibt einen Punkt, eine Runde
dauert 30 Sekunden.

## Befehle

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklungsserver mit Hot Reload auf http://localhost:5180 (anderer Port: `GAME_DEV_PORT`) |
| `npm run build` | Typprüfung und Produktions-Build nach `dist/` |
| `npm test` | Unit-Tests der Spiellogik (Vitest, ohne Browser) |
| `npm run test:smoke` | Baut und prüft im Browser (Playwright), dass der Canvas zeichnet und keine Konsolenfehler auftreten |
| `npm run review` | Baut und liefert den Stand aus (Review-Container von AIdeation, Port aus `REVIEW_FRONTEND_PORT`) |

Der Smoke-Test braucht Chromium für Playwright: `npx playwright install chromium` (unter Linux einmalig zusätzlich
`npx playwright install-deps chromium`).

## Aufbau

```
src/
  logic/       Spiellogik ohne Phaser (Zustand, Regeln) – mit Unit-Tests daneben (*.test.ts)
  scenes/      Phaser-Szenen: Eingabe lesen, Logik aufrufen, Ergebnis zeichnen
  main.ts      Phaser.Game mit Grösse, Skalierung und Szenen
e2e/           Playwright-Smoke-Test
```

Regeln für Änderungen (auch für die KI-Agents) stehen in [AGENTS.md](AGENTS.md).
