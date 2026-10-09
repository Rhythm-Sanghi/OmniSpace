import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Node tests do not process styles or inherit a parent directory's PostCSS setup.
  css: { postcss: { plugins: [] } },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['core/src/**'],
      thresholds: {
        lines: 70,
        functions: 75,
        branches: 65,
        statements: 70,
      },
    },
  },
});
