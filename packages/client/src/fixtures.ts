import type { PortfolioSnapshot } from '@finance-tools/portfolio-domain';
export function snapshotFixture(capturedAt = new Date().toISOString()): PortfolioSnapshot {
  return {
    id: 'snapshot',
    accountId: 'provider-account',
    provenance: { provider: 'fsm', capturedAt, source: 'test-fixture', complete: false, flags: [] },
    holdings: [],
  };
}
