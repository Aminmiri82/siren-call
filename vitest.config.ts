import { defineConfig } from 'vitest/config';

// Tests exercise the built output in dist/, because the Lua adapter resolves its worker and
// runtime.lua relative to its own compiled location. Building here keeps a bare `vitest` honest.
export default defineConfig({
  test: {
    globalSetup: ['./tests/build.ts'],
    testTimeout: 15_000,
  },
});
