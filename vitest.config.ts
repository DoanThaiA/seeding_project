import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    // Integration tests share one embedded Postgres; each file gets its own database.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
