import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.{test,spec}.ts', 'src/**/*.test.ts'],
    exclude: ['packages/**', 'node_modules/**', 'dist/**'],
  },
});
