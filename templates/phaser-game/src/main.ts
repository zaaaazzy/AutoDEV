import Phaser from 'phaser';
import { DEFAULT_CONFIG } from './logic/game-state';
import { MainScene } from './scenes/main-scene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: DEFAULT_CONFIG.width,
  height: DEFAULT_CONFIG.height,
  backgroundColor: '#10141f',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [MainScene],
});

// Für den Smoke-Test und die Fehlersuche in der Browser-Konsole.
declare global {
  interface Window {
    game?: Phaser.Game;
  }
}
window.game = game;
