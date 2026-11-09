import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Absolute path of a folder given relative to this config file. */
function folderNextToThisConfig(relativeFolderPath: string): string {
  return decodeURIComponent(new URL(relativeFolderPath, import.meta.url).pathname);
}

// Import paths (CLAUDE.md: no relative imports, ESLint enforces it):
//   @/...         -> apps/web/src/...
//   @protocol/... -> packages/protocol/src/...
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': folderNextToThisConfig('src'),
      '@protocol': folderNextToThisConfig('../../packages/protocol/src'),
    },
  },
});
