import { expect, it } from 'vitest';
import { normalizeEndowus, normalizeFsm, normalizeOcbc } from './src/index';
const capturedAt = '2025-03-10T00:00:00Z';
it('unions synthetic Endowus sources and treats ending balance plus pending as valuation', async () => {
  const result = await normalizeEndowus(
    {
      performance: [
        {
          goalId: 'a',
          totalInvestmentValue: { amount: '100.10' },
          pendingProcessingAmount: '2.20',
        },
      ],
      investible: [{ goalId: 'b', totalInvestmentAmount: '50.00' }],
      goals: [{ goalId: 'c', goalName: 'Missing values' }],
    },
    capturedAt,
  );
  expect(result).toHaveLength(3);
  expect(result[0].holdings[0].valuation?.minor).toBe(10230);
  expect(result[1].holdings[0].valuation?.minor).toBe(5000);
  expect(result[1].holdings[0].costBasis).toBeNull();
  expect(result[2].holdings[0].valuation).toBeNull();
});
it('preserves FSM account/code/subcode identity and nullable profit', async () => {
  const data = await normalizeFsm(
    {
      data: [
        {
          refno: 'secret-account',
          holdings: [
            { code: 'X', subcode: 'A', currentValueLcy: '20', profitValueLcy: '5' },
            { code: 'X', subcode: 'B', currentValueLcy: '30' },
            { code: 'H', productType: 'DPMS_HEADER' },
          ],
        },
        { refno: 'other', holdings: [{ code: 'X', subcode: 'A' }] },
      ],
    },
    capturedAt,
  );
  expect(data[0].holdings).toHaveLength(2);
  expect(data[0].holdings[0].costBasis?.minor).toBe(1500);
  expect(new Set(data.flatMap((s) => s.holdings.map((h) => h.id))).size).toBe(3);
  expect(data[0].id).not.toContain('secret-account');
});
it('keeps OCBC liabilities scoped and refuses fabricated fallback currency', async () => {
  const row = {
    positionId: 'same',
    marketValueOriginalCcy: { parsedValue: null, source: '12.34' },
  };
  const data = await normalizeOcbc(
    {
      data: [
        {
          portfolioNo: 'p',
          assets: [
            {
              subAssets: [{ holdings: [row, { ...row, positionId: 'known', originalCcy: 'USD' }] }],
            },
          ],
          liabilities: [{ subAssets: [{ holdings: [row] }] }],
        },
      ],
    },
    capturedAt,
  );
  expect(data[0].holdings[0].valuation).toBeNull();
  expect(data[0].holdings[1].valuation).toEqual({ minor: 1234, currency: 'USD' });
  expect(data[0].holdings[2].id).not.toBe(data[0].holdings[0].id);
  expect(data[0].provenance.complete).toBe(false);
});
