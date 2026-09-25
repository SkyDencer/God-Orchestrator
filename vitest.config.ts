import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Map .js imports to .ts source files for ESM compatibility
      '~': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    server: {
      deps: {
        inline: ['better-sqlite3'],
      },
    },
  },
});
