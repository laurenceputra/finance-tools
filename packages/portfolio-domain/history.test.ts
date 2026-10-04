import { expect, it } from 'vitest';
import {
  aggregateCardHistory,
  bindCardCapture,
  threeMonthCutoff,
  retainThreeMonths,
  provenance,
  partitionCardCaptureByPostingDate,
} from './src/index';
import type { CardCapture } from './src/index';
const capture = (capturedAt = '2025-05-31T00:00:00Z', minor = 1000): CardCapture => ({
  id: capturedAt,
  accountId: 'unidentified',
  persistence: 'ephemeral',
  card: 'uob-lady-solitaire',
  provenance: provenance('uob', capturedAt, 'fixture', [
    'ACCOUNT_CONTEXT_UNAVAILABLE',
    'EPHEMERAL_ONLY',
  ]),
  transactions: [
    {
      id: 'old-id',
      identityKey: 'source-reference-1',
      reference: '900719925474099312345',
      postingDate: '2025-05-01',
      transactionDate: null,
      merchant: 'SHOP',
      spending: { minor, currency: 'SGD' },
    },
  ],
});
it('clamps rolling UTC months, including leap years and Singapore rollover', () => {
  expect(threeMonthCutoff('2025-05-31T23:59:59Z')).toBe('2025-02-28');
  expect(threeMonthCutoff('2024-05-31T23:59:59Z')).toBe('2024-02-29');
  expect(threeMonthCutoff('2025-03-31T16:00:00Z')).toBe('2024-12-31');
  expect(threeMonthCutoff('2025-04-01T00:00:00+08:00')).toBe('2024-12-31');
  expect(
    retainThreeMonths(
      ['2025-02-27', '2025-02-28', '2025-06-01', '2025-06-02'].map((postingDate) => ({
        postingDate,
      })),
      '2025-05-31T16:00:00Z',
    ).map((row) => row.postingDate),
  ).toEqual(['2025-02-28', '2025-06-01']);
});
it('never assumes synthetic Maybank captures are disjoint or identical', async () => {
  const input = capture();
  input.card = 'maybank-xl';
  input.provenance.provider = 'maybank';
  input.transactions[0].identityConfidence = 'snapshot-local';
  const early = await bindCardCapture(input, 'one');
  const late = await bindCardCapture(
    {
      ...input,
      id: 'later',
      provenance: { ...input.provenance, capturedAt: '2025-06-01T00:00:00Z' },
      transactions: [
        {
          ...input.transactions[0],
          id: 'new',
          identityKey: 'new-local',
          spending: { minor: 500, currency: 'SGD' },
        },
      ],
    },
    'one',
  );
  const result = aggregateCardHistory([early, late])[0];
  expect(result.totalsMinor.SGD).toBe(500);
  expect(result.transactions).toHaveLength(1);
  expect(result.totalsConfidence).toBe('latest-capture-lower-bound');
  expect(result.ambiguousMonths).toContain('2025-05');
  expect(result.ambiguousTransactionIds).toContain(early.transactions[0].id);
});
it('partitions by posting day without refreshing retention and reassembles one Maybank observation', async () => {
  const input = capture();
  input.card = 'maybank-xl';
  input.provenance.provider = 'maybank';
  input.transactions.push({
    ...input.transactions[0],
    id: 'day2',
    identityKey: 'day2',
    postingDate: '2025-05-02',
  });
  const bound = await bindCardCapture(input, 'one'),
    partitions = await partitionCardCaptureByPostingDate(bound);
  expect(partitions.map((row) => row.occurredAt)).toEqual([
    '2025-05-01T00:00:00.000Z',
    '2025-05-02T00:00:00.000Z',
  ]);
  expect(partitions[0].capture.provenance.capturedAt).toBe(bound.provenance.capturedAt);
  expect(aggregateCardHistory(partitions.map((row) => row.capture))[0].totalsMinor.SGD).toBe(2000);
});
it('binds without plaintext leakage, mutating input or changing ids upon repeated binding', async () => {
  const original = capture(),
    a = await bindCardCapture(original, 'secret account 123'),
    b = await bindCardCapture(original, 'secret account 456');
  expect(a.persistence).toBe('account-bound');
  expect(original.persistence).toBe('ephemeral');
  expect(a.provenance.flags).not.toContain('EPHEMERAL_ONLY');
  expect(a.accountId).not.toContain('123');
  expect(a.id).not.toBe(b.id);
  expect(a.transactions[0].id).not.toBe(b.transactions[0].id);
  expect((await bindCardCapture(a, 'secret account 123')).transactions[0].id).toBe(
    a.transactions[0].id,
  );
  await expect(bindCardCapture(original, ' ')).rejects.toThrow();
  expect(() => aggregateCardHistory([original])).toThrow();
});
it('deduplicates overlap with chronological corrections, scoped accounts and unknown coverage', async () => {
  const early = await bindCardCapture(capture('2025-05-30T00:00:00Z'), 'one');
  const late = await bindCardCapture(capture('2025-05-31T00:00:00Z', -200), 'one');
  const other = await bindCardCapture(capture(), 'two');
  const history = aggregateCardHistory([late, other, early, early]);
  const one = history.find((row) => row.accountId === early.accountId)!;
  expect(history).toHaveLength(2);
  expect(one.transactions).toHaveLength(1);
  expect(one.totalsMinor.SGD).toBe(-200);
  expect(one.changes).toHaveLength(1);
  expect(one.changes[0].previous.spending.minor).toBe(1000);
  expect(one.coverage).toBe('unknown');
  expect(one.provenance.complete).toBe(false);
  expect(one.provenance.flags).toContain('TRANSACTION_CORRECTIONS_PRESENT');
  expect(aggregateCardHistory([early], '2025-09-01T00:00:00Z')[0].transactions).toEqual([]);
});
it('does not collapse repeated source occurrences and refuses unsafe history totals', async () => {
  const input = capture();
  input.transactions.push({
    ...input.transactions[0],
    id: 'second',
    identityKey: 'source-reference-2',
  });
  const bound = await bindCardCapture(input, 'one');
  expect(aggregateCardHistory([bound])[0].totalsMinor.SGD).toBe(2000);
  bound.transactions[0].spending.minor = Number.MAX_SAFE_INTEGER;
  expect(() => aggregateCardHistory([bound])).toThrow(RangeError);
});
