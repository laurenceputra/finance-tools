import { expect, it } from 'vitest';
import {
  calculateAllocations,
  parseAllocationSettings,
  parseCardCapture,
  parseCardSettings,
  parsePortfolioSnapshot,
  timestampSchema,
} from './src/index';
import type { PortfolioSnapshot } from './src/index';
const snapshot: PortfolioSnapshot = {
  id: 's',
  accountId: 'a',
  accountType: 'cash',
  provenance: {
    provider: 'fsm',
    capturedAt: '2025-05-31T00:00:00Z',
    source: 'fixture',
    complete: false,
    flags: [],
  },
  holdings: [
    {
      id: 'h1',
      name: 'First',
      code: 'X',
      subcode: '',
      section: 'asset',
      valuation: { minor: 6000, currency: 'SGD' },
      profit: null,
      costBasis: null,
      returnPercent: null,
      flags: [],
    },
    {
      id: 'h2',
      name: 'Second',
      code: 'Y',
      subcode: '',
      section: 'asset',
      valuation: { minor: 4000, currency: 'SGD' },
      profit: null,
      costBasis: null,
      returnPercent: null,
      flags: [],
    },
    {
      id: 'usd',
      name: 'Other currency',
      code: 'U',
      subcode: '',
      section: 'asset',
      valuation: { minor: 99900, currency: 'USD' },
      profit: null,
      costBasis: null,
      returnPercent: null,
      flags: [],
    },
    {
      id: 'debt',
      name: 'Debt',
      code: 'D',
      subcode: '',
      section: 'liability',
      valuation: { minor: 20000, currency: 'SGD' },
      profit: null,
      costBasis: null,
      returnPercent: null,
      flags: [],
    },
  ],
};
const scope = {
  id: 'scope',
  bucket: 'Retirement',
  accountId: 'a',
  currency: 'SGD',
  section: 'asset' as const,
  accountType: 'cash' as const,
  targets: { h1: { targetBps: 5000 }, h2: { targetBps: 5000 } },
};
it('calculates targets, actual ratios, signed drift and projected deposit without FX or debt netting', () => {
  const result = calculateAllocations([snapshot], {
    scopes: [{ ...scope, projectedDeposit: { minor: 2000, currency: 'SGD' } }],
  })[0];
  expect(result.actualTotalMinor).toBe(10000);
  expect(result.projectedTotalMinor).toBe(12000);
  expect(result.rows[0]).toMatchObject({
    actualBps: 6000,
    targetMinor: 6000,
    deltaMinor: 0,
    driftBps: 1000,
  });
  expect(result.rows[1]).toMatchObject({
    actualBps: 4000,
    targetMinor: 6000,
    deltaMinor: 2000,
    driftBps: -1000,
  });
  expect(result.rows).toHaveLength(2);
  expect(result).not.toHaveProperty('returnPercent');
});
it('handles fixed/excluded/amount targets and unknown valuations conservatively', () => {
  const result = calculateAllocations([snapshot], {
    scopes: [{ ...scope, targets: { h1: { fixed: true }, h2: { excluded: true } } }],
  })[0];
  expect(result.actualTotalMinor).toBe(6000);
  expect(result.rows[0].deltaMinor).toBe(0);
  expect(result.rows[1].targetMinor).toBeNull();
  const unknown = {
    ...snapshot,
    holdings: snapshot.holdings.map((row) => (row.id === 'h2' ? { ...row, valuation: null } : row)),
  };
  const incomplete = calculateAllocations([unknown], { scopes: [scope] })[0];
  expect(incomplete.warnings).toContain('UNKNOWN_VALUATION_DENOMINATOR');
  expect(incomplete.rows[0].actualBps).toBeNull();
  expect(incomplete.rows[0].targetMinor).toBeNull();
  expect(
    calculateAllocations([snapshot], {
      scopes: [{ ...scope, targets: { h1: { targetAmount: { minor: 7000, currency: 'SGD' } } } }],
    })[0].rows[0].deltaMinor,
  ).toBe(1000);
});
it('rejects invalid scopes, currencies, settings records and unsafe normalized data', () => {
  expect(() =>
    parseAllocationSettings({ scopes: [{ ...scope, targets: { h1: { targetBps: 10001 } } }] }),
  ).toThrow();
  expect(() =>
    parseAllocationSettings({
      scopes: [{ ...scope, targets: { h1: { targetAmount: { minor: 1, currency: 'USD' } } } }],
    }),
  ).toThrow();
  expect(() => parseCardSettings(null)).toThrow();
  expect(() => parseCardSettings({ selectedCategories: [], merchantMap: null })).toThrow();
  expect(() =>
    parseCardSettings({
      selectedCategories: [],
      merchantMap: JSON.parse('{"__proto__":"Dining"}'),
    }),
  ).toThrow();
  expect(
    parseCardSettings({ selectedCategories: [], merchantMap: { toString: 'Dining' } }).merchantMap
      ?.toString,
  ).toBe('Dining');
  expect(() =>
    parsePortfolioSnapshot({ ...snapshot, provenance: { ...snapshot.provenance, flags: [123] } }),
  ).toThrow();
  expect(() => parsePortfolioSnapshot({ ...snapshot, providerExtra: true })).toThrow();
  expect(() =>
    parsePortfolioSnapshot({
      ...snapshot,
      holdings: [{ ...snapshot.holdings[0], valuation: { minor: 1.2, currency: 'SGD' } }],
    }),
  ).toThrow();
  expect(() => parseCardCapture({})).toThrow();
});
it('validates timestamps without accepting normalized impossible dates or unbounded future captures', () => {
  expect(timestampSchema.safeParse('2025-02-30T00:00:00Z').success).toBe(false);
  expect(timestampSchema.safeParse('2025-05-31T00:00:00').success).toBe(false);
  expect(timestampSchema.safeParse('9999-05-31T00:00:00Z').success).toBe(false);
  expect(timestampSchema.safeParse('2025-05-31T00:00:00+08:00').success).toBe(true);
});
