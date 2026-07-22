import { defineConfig } from 'vitest/config';

/**
 * Vitest runs backend module tests in a Node environment. Tests are colocated as
 * `*.test.ts` next to the code they cover. Globals are OFF on purpose: tests import
 * { describe, it, expect, vi } from 'vitest' so backend tsconfig can keep
 * `types: ["node"]` and never leak test globals into production type-checking.
 *
 * NodeNext ".js" import specifiers that point at ".ts" sources resolve correctly
 * here because Vite's resolver maps the emitted extension back to the source file.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
    clearMocks: true,
    testTimeout: 15_000,
  },
});
