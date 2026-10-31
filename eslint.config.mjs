import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .dev-log: Laufzeitdaten (Anhänge, Hilfsskripte), kein Projektcode. test-results: Testausgaben (gitignoriert); sonst
  // wäre der CI-Spiegel im Worktree rot, obwohl die echte CI (frischer Checkout) sie nie sieht.
  { ignores: ['dist/**', '.angular/**', 'node_modules/**', '.dev-log/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: 'error',
    },
  },
  // Tests (und die Playwright-Prüfungen unter e2e/) dürfen Treffer und Indizes mit „!“ behaupten; ein Fehlgriff zeigt sich dort sofort als roter Test.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'e2e/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'warn' },
  },
);
