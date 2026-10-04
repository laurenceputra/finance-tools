import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: {
      '@finance-tools/card-rules': new URL(
        '../../packages/card-rules/src/index.ts',
        import.meta.url,
      ).pathname,
      '@finance-tools/portfolio-domain': new URL(
        '../../packages/portfolio-domain/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  esbuild: { jsx: 'automatic' },
  test: { include: ['apps/web/src/**/*.test.ts', 'apps/web/tests/**/*.test.ts'] },
});
