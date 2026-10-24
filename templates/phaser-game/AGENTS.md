# Richtlinien für Agents

Dieses Projekt ist ein Browser-Spiel mit Phaser 3, TypeScript und Vite.

## Aufbau

- **Spiellogik von Phaser-Szenen trennen.** Regeln, Zustand, Kollisionen, Punkte und Zeit gehören in `src/logic/` als
  reine Funktionen ohne `import 'phaser'`, ohne DOM und ohne Canvas. So sind sie mit Vitest im Node-Prozess testbar.
- Szenen (`src/scenes/`) lesen nur die Eingabe, rufen die Logik auf und zeichnen das Ergebnis. Keine Spielregeln in
  `update()` verstecken.
- Zufall über einen Seed (siehe `nextRandom` in `src/logic/game-state.ts`), damit Tests reproduzierbar sind.
- Zeit immer über `delta` aus `update(time, delta)` rechnen, nie in Frames – das Spiel läuft sonst je nach
  Bildwiederholrate verschieden schnell.
- Grafiken und Töne unter `public/assets/` ablegen und im `preload()` der Szene laden; Pfade ohne führenden Ordner
  `public/` (z. B. `assets/player.png`).
- Phaser 3 bleiben (kein Wechsel auf Phaser 4 ohne eigenen Auftrag); die API-Doku steht unter
  https://newdocs.phaser.io/docs/3.90.0.

## Tests

- Jede neue Regel bekommt einen Unit-Test neben der Datei (`src/logic/<name>.test.ts`).
- `npm run build` (Typprüfung + Build), `npm test` und `npm run test:smoke` müssen grün sein.
- Der Smoke-Test (`e2e/smoke.spec.ts`) prüft, dass der Canvas zeichnet und keine Konsolenfehler auftreten. Neue
  Szenen dort mit aufnehmen, wenn sie ohne Eingabe erreichbar sind.
- Keine Konsolenausgaben mit `console.error` für erwartete Fälle – der Smoke-Test wertet sie als Fehler.
