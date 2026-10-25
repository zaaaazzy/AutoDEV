import { describe, expect, it } from 'vitest';
import { createGame, DEFAULT_CONFIG, distance, nextRandom, placeStar, step } from './game-state';

describe('Spiellogik', () => {
  it('startet mit der Figur in der Mitte, 0 Punkten und voller Zeit', () => {
    const game = createGame(42);
    expect(game.player).toEqual({ x: DEFAULT_CONFIG.width / 2, y: DEFAULT_CONFIG.height / 2 });
    expect(game.score).toBe(0);
    expect(game.secondsLeft).toBe(DEFAULT_CONFIG.roundSeconds);
    expect(game.over).toBe(false);
  });

  it('erzeugt mit demselben Seed dieselben Sterne', () => {
    expect(createGame(7).star).toEqual(createGame(7).star);
    expect(createGame(7).star).not.toEqual(createGame(8).star);
  });

  it('liefert Zufallszahlen in [0, 1)', () => {
    let seed = 123;
    for (let index = 0; index < 1000; index += 1) {
      const result = nextRandom(seed);
      expect(result.value).toBeGreaterThanOrEqual(0);
      expect(result.value).toBeLessThan(1);
      seed = result.seed;
    }
  });

  it('setzt Sterne nie an den Rand', () => {
    let seed = 5;
    for (let index = 0; index < 200; index += 1) {
      const placed = placeStar(seed);
      expect(placed.star.x).toBeGreaterThanOrEqual(DEFAULT_CONFIG.starRadius);
      expect(placed.star.x).toBeLessThanOrEqual(DEFAULT_CONFIG.width - DEFAULT_CONFIG.starRadius);
      expect(placed.star.y).toBeGreaterThanOrEqual(DEFAULT_CONFIG.starRadius);
      expect(placed.star.y).toBeLessThanOrEqual(DEFAULT_CONFIG.height - DEFAULT_CONFIG.starRadius);
      seed = placed.seed;
    }
  });

  it('bewegt die Figur mit der eingestellten Geschwindigkeit', () => {
    const game = step(createGame(), { x: 1, y: 0 }, 0.5);
    expect(game.player.x).toBeCloseTo(DEFAULT_CONFIG.width / 2 + DEFAULT_CONFIG.playerSpeed * 0.5);
    expect(game.player.y).toBe(DEFAULT_CONFIG.height / 2);
  });

  it('ist diagonal nicht schneller als gerade aus', () => {
    const start = createGame();
    const moved = step(start, { x: 1, y: 1 }, 0.1);
    expect(distance(start.player, moved.player)).toBeCloseTo(DEFAULT_CONFIG.playerSpeed * 0.1);
  });

  it('hält die Figur im Spielfeld', () => {
    const game = step(createGame(), { x: -1, y: -1 }, 60);
    expect(game.player).toEqual({ x: DEFAULT_CONFIG.playerRadius, y: DEFAULT_CONFIG.playerRadius });
  });

  it('zählt einen eingesammelten Stern und setzt einen neuen', () => {
    const start = createGame(3);
    const onStar = { ...start, player: { ...start.star } };
    const game = step(onStar, { x: 0, y: 0 }, 0.016);
    expect(game.score).toBe(1);
    expect(game.star).not.toEqual(start.star);
  });

  it('beendet die Runde, wenn die Zeit abgelaufen ist, und ändert danach nichts mehr', () => {
    const over = step(createGame(), { x: 0, y: 0 }, DEFAULT_CONFIG.roundSeconds + 1);
    expect(over.secondsLeft).toBe(0);
    expect(over.over).toBe(true);
    expect(step(over, { x: 1, y: 0 }, 1)).toBe(over);
  });
});
