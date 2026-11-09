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
  { files: ['*.js'], languageOptions: { globals: globals.node } },
  prettier,
);
