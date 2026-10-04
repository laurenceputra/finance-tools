import { expect, it } from 'vitest';
import { evaluateMonthly, resolveCategory, RULES } from './src/index';
import type { CardTransaction } from '../portfolio-domain/src/index';
const tx = (merchant: string, minor: number, postingDate = '2025-03-01'): CardTransaction => ({
  id: merchant,
  identityConfidence: 'provider-reference',
  reference: '',
  postingDate,
  transactionDate: null,
  merchant,
  spending: { minor, currency: 'SGD' },
});
it('resolves exact before wildcard and treats escaped stars literally', () => {
  const settings = {
    selectedCategories: [],
    merchantMap: { '*': 'Other', 'Shop\\*': 'Literal', Shop: 'Exact', 'A.B*': 'RegexSafe' },
  };
  expect(resolveCategory('Shop', settings, 'uob-lady-solitaire')).toBe('Exact');
  expect(resolveCategory('shop*', settings, 'uob-lady-solitaire')).toBe('Literal');
  expect(resolveCategory('local SGP', settings, 'maybank-xl')).toBe('Other');
  expect(resolveCategory('local SGP', { selectedCategories: [] }, 'maybank-xl')).toBe('Local');
});
it('suppresses remaining caps for snapshot-local ambiguity and partial oldest month', () => {
  const ambiguous = evaluateMonthly(
    'maybank-xl',
    [{ ...tx('SHOP SGP', 1000), identityConfidence: 'snapshot-local' }],
    { selectedCategories: ['Local'] },
    '2025-03-10T00:00:00Z',
  )[0];
  expect(ambiguous.remainingMinor).toBeNull();
  expect(ambiguous.warnings).toContain('SNAPSHOT_LOCAL_IDENTITY_AMBIGUITY');
  const partial = evaluateMonthly(
    'uob-lady-solitaire',
    [tx('SHOP', 1000, '2024-12-15')],
    { selectedCategories: ['Others'] },
    '2025-03-10T00:00:00Z',
  )[0];
  expect(partial.remainingMinor).toBeNull();
  expect(partial.warnings).toContain('PARTIAL_RETENTION_MONTH');
  expect(partial.incomplete).toBe(true);
});
it('caps selected categories individually and reduces spend with credits', () => {
  const result = evaluateMonthly(
    'uob-lady-solitaire',
    [tx('A', 80000), tx('A', -10000), tx('B', 90000), tx('C', 50000), tx('A', 999, '2024-12-09')],
    { selectedCategories: ['A', 'B'], merchantMap: { A: 'A', B: 'B' } },
    '2025-03-10T00:00:00Z',
  )[0];
  expect(result.totalMinor).toBe(210000);
  expect(result.eligibleMinor).toBe(145000);
  expect(result.remainingMinor?.A).toBe(5000);
  expect(RULES['uob-lady-solitaire'].status).toBe('UNVERIFIED');
});
it('does not qualify unselected spend or inflate eligibility after excess refunds', () => {
  const transactions = [tx('A', 10000), tx('A', -20000), tx('B', 90000)];
  const settings = { selectedCategories: ['A', 'A'], merchantMap: { A: 'A', B: 'B' } };
  const uob = evaluateMonthly(
    'uob-lady-solitaire',
    transactions,
    settings,
    '2025-03-10T00:00:00Z',
  )[0];
  expect(uob.totalMinor).toBe(80000);
  expect(uob.totals.A).toBe(-10000);
  expect(uob.eligibleMinor).toBe(0);
  expect(uob.remainingMinor?.A).toBe(75000);
  const maybank = evaluateMonthly('maybank-xl', transactions, settings, '2025-03-10T00:00:00Z')[0];
  expect(maybank.eligibleMinor).toBe(0);
  expect(maybank.remainingMinor?.combined).toBe(100000);
  expect(() =>
    evaluateMonthly(
      'maybank-xl',
      [{ ...tx('A', 1), spending: { minor: 1, currency: 'USD' } }],
      settings,
      '2025-03-10T00:00:00Z',
    ),
  ).toThrow();
});
it('uses a combined Maybank selected cap', () => {
  const result = evaluateMonthly(
    'maybank-xl',
    [tx('A SGP', 70000), tx('B USA', 60000)],
    { selectedCategories: ['Local', 'Forex'] },
    '2025-03-10T00:00:00Z',
  )[0];
  expect(result.eligibleMinor).toBe(100000);
  expect(result.remainingMinor?.combined).toBe(0);
});
