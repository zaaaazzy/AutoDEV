import Phaser from 'phaser';
import { createGame, DEFAULT_CONFIG, type GameState, step } from '../logic/game-state';

/** Beispielszene „Sterne sammeln“: liest Tastatur und Zeiger, rechnet über die Spiellogik und zeichnet das Ergebnis. */
export class MainScene extends Phaser.Scene {
  private state: GameState = createGame();
  private player!: Phaser.GameObjects.Arc;
  private star!: Phaser.GameObjects.Star;
  private hud!: Phaser.GameObjects.Text;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;

  constructor() {
    super('main');
  }

  /** Aktueller Spielzustand (nur lesen), z. B. für den Smoke-Test. */
  get current(): GameState {
    return this.state;
  }

  create(): void {
    this.state = createGame(Date.now() >>> 0);
    this.add.grid(400, 300, 800, 600, 40, 40, 0x10141f, 1, 0x1d2333, 1);
    this.star = this.add.star(0, 0, 5, DEFAULT_CONFIG.starRadius / 2, DEFAULT_CONFIG.starRadius, 0xffd54a);
    this.player = this.add.circle(0, 0, DEFAULT_CONFIG.playerRadius, 0x4fc3f7);
    this.hud = this.add.text(16, 12, '', { fontFamily: 'sans-serif', fontSize: '20px', color: '#ffffff' });
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.input.keyboard?.on('keydown-SPACE', () => {
      if (this.state.over) this.scene.restart();
    });
    this.render();
  }

  update(_time: number, deltaMs: number): void {
    this.state = step(this.state, this.readInput(), deltaMs / 1000);
    this.render();
  }

  /** Pfeiltasten oder gedrückter Zeiger (Maus, Touch) in Richtung der Spielfigur. */
  private readInput(): { x: number; y: number } {
    const pointer = this.input.activePointer;
    if (pointer.isDown) {
      const dx = pointer.worldX - this.state.player.x;
      const dy = pointer.worldY - this.state.player.y;
      const length = Math.hypot(dx, dy);
      return length > 4 ? { x: dx / length, y: dy / length } : { x: 0, y: 0 };
    }
    const keys = this.cursors;
    if (!keys) return { x: 0, y: 0 };
    return {
      x: (keys.right.isDown ? 1 : 0) - (keys.left.isDown ? 1 : 0),
      y: (keys.down.isDown ? 1 : 0) - (keys.up.isDown ? 1 : 0),
    };
  }

  private render(): void {
    this.player.setPosition(this.state.player.x, this.state.player.y);
    this.star.setPosition(this.state.star.x, this.state.star.y);
    this.hud.setText(
      this.state.over
        ? `Zeit um! ${this.state.score} Sterne – Leertaste für eine neue Runde`
        : `Sterne: ${this.state.score}   Zeit: ${Math.ceil(this.state.secondsLeft)} s`,
    );
  }
}
