import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.reference/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: no `any` without a comment explaining why (use eslint-disable with a reason).
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Code rules from CLAUDE.md, for all app and package code.
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    rules: {
      // No relative imports: use @/... (apps/web/src) or @protocol/... (packages/protocol/src).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\.?(/|$)',
              message:
                'No relative imports: use @/... (apps/web/src) or @protocol/... (packages/protocol/src). See CLAUDE.md.',
            },
          ],
        },
      ],
      // Names say what they hold: no one- or two-letter names except these few conventions.
      'id-length': [
        'error',
        { min: 3, properties: 'never', exceptions: ['i', 'j', 'id', 'ok', 'it', '_'] },
      ],
    },
  },
  { files: ['apps/web/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['*.js', 'scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
  {
    // Build-time and end-to-end test code runs in Node, the Vite config loader and Playwright,
    // which do not resolve `@/`, so it imports its neighbours with relative paths. It is never
    // bundled into the app.
    files: [
      'apps/web/build-tools/**/*.ts',
      'apps/web/vite.config.ts',
      'apps/web/e2e/**/*.ts',
      'apps/web/playwright.config.ts',
    ],
    languageOptions: { globals: globals.node },
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
);
