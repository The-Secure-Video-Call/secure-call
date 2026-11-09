import { defineConfig } from 'vitest/config';

// Import paths (CLAUDE.md: no relative imports): @protocol/... -> packages/protocol/src/...
export default defineConfig({
  resolve: {
    alias: {
      '@protocol': decodeURIComponent(new URL('src', import.meta.url).pathname),
    },
  },
});
