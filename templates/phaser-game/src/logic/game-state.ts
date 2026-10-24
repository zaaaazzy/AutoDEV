/**
 * Spiellogik ohne Phaser: reine Daten und Funktionen, damit sie ohne Browser und Canvas testbar ist.
 * Die Szene liest den Zustand nur aus und zeichnet ihn.
 */

export interface Vector {
  x: number;
  y: number;
}

export interface GameConfig {
  width: number;
  height: number;
  /** Geschwindigkeit der Spielfigur in Pixel pro Sekunde. */
  playerSpeed: number;
  playerRadius: number;
  starRadius: number;
  /** Rundendauer in Sekunden. */
  roundSeconds: number;
}

export interface GameState {
  player: Vector;
  star: Vector;
  score: number;
  secondsLeft: number;
  over: boolean;
  /** Zustand des Zufallsgenerators, damit Sternpositionen reproduzierbar sind. */
  seed: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  width: 800,
  height: 600,
  playerSpeed: 260,
  playerRadius: 18,
  starRadius: 12,
  roundSeconds: 30,
};

/** Kleiner, deterministischer Zufallsgenerator (mulberry32): liefert die Zahl in [0, 1) und den nächsten Seed. */
export function nextRandom(seed: number): { value: number; seed: number } {
  const next = (seed + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function distance(a: Vector, b: Vector): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Neuer Stern an einer zufälligen Stelle mit Abstand zum Rand. */
export function placeStar(seed: number, config: GameConfig = DEFAULT_CONFIG): { star: Vector; seed: number } {
  const margin = config.starRadius * 2;
  const x = nextRandom(seed);
  const y = nextRandom(x.seed);
  return {
    star: {
      x: margin + x.value * (config.width - margin * 2),
      y: margin + y.value * (config.height - margin * 2),
    },
    seed: y.seed,
  };
}

export function createGame(seed = 1, config: GameConfig = DEFAULT_CONFIG): GameState {
  const placed = placeStar(seed, config);
  return {
    player: { x: config.width / 2, y: config.height / 2 },
    star: placed.star,
    score: 0,
    secondsLeft: config.roundSeconds,
    over: false,
    seed: placed.seed,
  };
}

/**
 * Ein Schritt der Simulation: bewegt die Spielfigur nach der Eingabe (je Achse -1 bis 1), sammelt den Stern ein und
 * zählt die Zeit herunter. `deltaSeconds` ist die seit dem letzten Schritt vergangene Zeit.
 */
export function step(
  state: GameState,
  input: Vector,
  deltaSeconds: number,
  config: GameConfig = DEFAULT_CONFIG,
): GameState {
  if (state.over) return state;
  const length = Math.hypot(input.x, input.y);
  // Diagonal nicht schneller als gerade aus.
  const scale = length > 1 ? 1 / length : 1;
  const player = {
    x: clamp(
      state.player.x + input.x * scale * config.playerSpeed * deltaSeconds,
      config.playerRadius,
      config.width - config.playerRadius,
    ),
    y: clamp(
      state.player.y + input.y * scale * config.playerSpeed * deltaSeconds,
      config.playerRadius,
      config.height - config.playerRadius,
    ),
  };
  let { star, score, seed } = state;
  if (distance(player, star) <= config.playerRadius + config.starRadius) {
    score += 1;
    ({ star, seed } = placeStar(seed, config));
  }
  const secondsLeft = Math.max(0, state.secondsLeft - deltaSeconds);
  return { player, star, score, seed, secondsLeft, over: secondsLeft === 0 };
}
