import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: no `any` without a comment explaining why (use eslint-disable with a reason).
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  { files: ['apps/web/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['apps/signaling/**/*.ts', '*.js'], languageOptions: { globals: globals.node } },
  prettier,
);
