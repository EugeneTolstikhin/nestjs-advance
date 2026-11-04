import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    env: { JOBS_DRIVER: 'inline' },
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
