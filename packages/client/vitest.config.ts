import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: {
      '@finance-tools/contracts': new URL('../contracts/src/index.ts', import.meta.url).pathname,
      '@finance-tools/crypto': new URL('../crypto/src/index.ts', import.meta.url).pathname,
      '@finance-tools/portfolio-domain': new URL(
        '../portfolio-domain/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: { include: ['packages/client/src/**/*.test.ts'] },
});
