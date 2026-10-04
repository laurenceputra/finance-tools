import { describe, expect, it } from 'vitest';
import { minorUnits, postingDate, retainThreeMonths, threeMonthCutoff, identity } from './src/index';
describe('safe shared domain', () => {
  it('rejects unsafe, malformed and rounded money', () => {
    expect(minorUnits('1,234.56')).toBe(123456);
    for (const input of ['', '1,23', '0.001', '900719925474099.99', true]) expect(minorUnits(input)).toBeNull();
    expect(minorUnits({ parsedValue: null, source: '-1.20' })).toBe(-120);
  });
  it('validates calendar dates and Singapore month rollover', () => {
    expect(postingDate('29 Feb 2024')).toBe('2024-02-29');
    expect(postingDate('29 Feb 2025')).toBeNull();
    expect(threeMonthCutoff('2025-03-31T16:00:00Z')).toBe('2024-12-31');
    expect(retainThreeMonths([{ postingDate: '2024-12-30' }, { postingDate: '2025-04-01' }], '2025-03-31T16:00:00Z')).toEqual([{ postingDate: '2025-04-01' }]);
  });
  it('scopes opaque deterministic identities', async () => {
    expect(await identity('a', '123456')).toBe(await identity('a', '123456'));
    expect(await identity('a', '123456')).not.toBe(await identity('b', '123456'));
  });
});
