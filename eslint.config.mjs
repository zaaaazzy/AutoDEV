import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .dev-log: Laufzeitdaten (Anhänge, Hilfsskripte), kein Projektcode.
  { ignores: ['dist/**', '.angular/**', 'node_modules/**', '.dev-log/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      eqeqeq: 'error',
    },
  },
);
