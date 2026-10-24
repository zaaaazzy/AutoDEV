import { defineConfig } from 'vitest/config';

// Der Review-Container von AIdeation setzt REVIEW_HOST und REVIEW_FRONTEND_PORT; lokal gelten die Vite-Standards.
const previewPort = Number(process.env.REVIEW_FRONTEND_PORT ?? 4173);
// 5180 statt Vites 5173, damit das Spiel nicht mit anderen Vite-Projekten kollidiert. Die Vorschau-Adresse in
// AIdeation zeigt auf diesen Port; wer GAME_DEV_PORT ändert, passt sie unter Einstellungen → Visuelle Prüfung an.
const devPort = Number(process.env.GAME_DEV_PORT ?? 5180);

export default defineConfig({
  server: { port: devPort, strictPort: true },
  preview: { host: process.env.REVIEW_HOST ?? 'localhost', port: previewPort, strictPort: true },
  build: {
    // Phaser allein ist gut 1 MB gross; die Warnung ab 500 kB wäre bei jedem Build da.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
