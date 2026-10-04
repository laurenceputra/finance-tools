import { expect, it } from 'vitest';
import { validateProductDocument, validateSettings } from './data';
import { previewLegacyConfig } from './legacy';
import { FinanceClient, mergeSettings } from './index';
import { snapshotFixture } from './fixtures';
import type { Storage } from './index';
import type { CardCapture } from '@finance-tools/portfolio-domain';
it('rejects malformed products, null settings, unsafe nesting and mismatched bank posting dates', () => {
  expect(() => validateSettings(null)).toThrow();
  expect(() => validateSettings({ cards: null })).toThrow();
  expect(() => validateSettings({ allocations: { scopes: [{ currency: 'USD' }] } })).toThrow();
  const now = new Date().toISOString(),
    day = now.slice(0, 10);
  const bank: CardCapture = {
    id: 'daily',
    accountId: 'bound',
    card: 'uob-lady-solitaire',
    persistence: 'account-bound',
    provenance: { provider: 'uob', capturedAt: now, source: 'fixture', complete: false, flags: [] },
    transactions: [
      {
        id: 'tx',
        reference: 'ref',
        merchant: 'Fixture merchant',
        postingDate: day,
        transactionDate: null,
        spending: { currency: 'SGD', minor: 100 },
      },
    ],
  };
  expect(
    validateProductDocument('bank-subcaps', 'history', bank, `${day}T00:00:00.000Z`),
  ).toBeTruthy();
  expect(() => validateProductDocument('bank-subcaps', 'history', bank, now)).toThrow(
    'posting-day',
  );
  expect(() => validateProductDocument('portfolio', 'history', { holdings: [] }, now)).toThrow();
  expect(() =>
    validateProductDocument('portfolio', 'history', snapshotFixture(now), `${day}T00:00:00.000Z`),
  ).toThrow('capture time');
});
it('preflights every decrypted import before any mutation', async () => {
  const values = new Map<string, unknown>(),
    storage: Storage = {
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async set(key, value) {
        values.set(key, value);
      },
      async delete(key) {
        values.delete(key);
      },
    };
  let writes = 0;
  const sid = 'sid',
    accessToken = `e30.${btoa(JSON.stringify({ sub: 'account', sid })).replace(/=/g, '')}.signature`;
  const client = new FinanceClient(
    async (path, method, body) => {
      if (path === '/session/refresh')
        return { status: 200, body: { accessToken, sessionId: sid, expiresIn: 900 } };
      if (path === '/vault')
        return { status: 200, body: { revision: 1, vault: (body as { vault: unknown }).vault } };
      if (method === 'PUT') writes++;
      return { status: 200, body: {} };
    },
    storage,
    'browser',
  );
  client.me = {
    accountId: 'account',
    namespaces: ['settings', 'history'],
    products: ['portfolio', 'bank-subcaps'],
  } as typeof client.me;
  await client.finishVault(await client.prepareVault('test-long-passphrase'));
  const now = new Date().toISOString();
  await expect(
    client.importDecrypted({
      format: 'finance-tools-decrypted',
      version: 1,
      accountId: 'old-account',
      exportedAt: now,
      documents: [
        { namespace: 'settings', product: 'portfolio', id: 'valid', value: {} },
        {
          namespace: 'history',
          product: 'portfolio',
          id: 'bad',
          value: { holdings: [] },
          occurredAt: now,
        },
      ],
    }),
  ).rejects.toThrow();
  expect(writes).toBe(0);
});
it('uses own properties during merge including legitimate toString keys', () => {
  const result = mergeSettings({}, { toString: 'remote' }, { another: 'local' });
  expect(result).toEqual({ toString: 'remote', another: 'local' });
  expect(Object.hasOwn(result as object, 'toString')).toBe(true);
});
it('imports legacy local config only after explicit source selection and account mapping', () => {
  const portfolio = {
    version: 4,
    platforms: {
      endowus: { allocation: { goalTargets: { goal: 25 }, goalFixed: { goal: true } } },
    },
    email: 'must-not-be-imported',
  };
  const review = previewLegacyConfig(portfolio, 'portfolio');
  expect(JSON.stringify(review.settings)).not.toContain('must-not-be-imported');
  expect(review.warnings).toContain(
    'LEGACY_CODES_REQUIRE_EXPLICIT_CURRENT_ACCOUNT_HOLDING_SCOPE_MAPPING',
  );
  expect(() => previewLegacyConfig(portfolio, 'bank-subcaps')).toThrow();
  const bank = previewLegacyConfig(
    {
      version: 1,
      data: {
        cards: { UOB: { selectedCategories: ['Dining'], merchantMap: { '*FOOD*': 'Dining' } } },
      },
    },
    'bank-subcaps',
    { UOB: 'explicit-bound-account' },
  );
  expect((bank.settings.cards as Record<string, unknown>)['explicit-bound-account']).toBeTruthy();
});
