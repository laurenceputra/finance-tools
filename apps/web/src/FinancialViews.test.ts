import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { CardCapture } from '@finance-tools/portfolio-domain';
import { FinancialViews } from './FinancialViews';
it('renders retained, account-deduplicated bank activity, corrections and actual unverified reference rules', () => {
  const now = new Date(),
    before = new Date(now.getTime() - 86400000),
    postingDate = before.toISOString().slice(0, 10);
  const tx = (id: string, merchant: string, minor: number) => ({
    id,
    reference: id,
    postingDate,
    transactionDate: null,
    merchant,
    spending: { currency: 'SGD', minor },
  });
  const capture = (
    id: string,
    accountId: string,
    capturedAt: string,
    transactions: CardCapture['transactions'],
  ): CardCapture => ({
    id,
    accountId,
    card: 'uob-lady-solitaire',
    persistence: 'account-bound',
    transactions,
    provenance: {
      provider: 'uob',
      capturedAt,
      source: 'visible-owned-table',
      complete: false,
      flags: [],
    },
  });
  const old = capture('old', 'account-a', before.toISOString(), [
    tx('same-id', 'Changed merchant', 100),
    tx('retained', 'Retained old merchant', 200),
  ]);
  const latest = capture('latest', 'account-a', now.toISOString(), [
    tx('same-id', 'Changed merchant', 400),
  ]);
  const other = capture('other', 'account-b', now.toISOString(), [
    tx('same-id', 'Separate account merchant', 700),
  ]);
  const html = renderToStaticMarkup(
    createElement(FinancialViews, {
      values: [old, latest, other],
      settings: {},
      bankSettings: {
        cards: {
          'account-a': { selectedCategories: ['Dining'], merchantMap: { '*merchant': 'Dining' } },
          'account-b': { selectedCategories: ['Dining'], defaultCategory: 'Dining' },
        },
      },
    }),
  ).replace(/<!--.*?-->/g, '');
  expect(html).toContain('Retained old merchant');
  expect(html).toContain('2 retained captures');
  expect(html).toContain('1 transaction corrections');
  expect(html).toContain('Total SGD 6.00');
  expect(html).toContain('Total SGD 7.00');
  expect(html).toContain('reference eligible SGD 6.00');
  expect(html).toContain('UNVERIFIED');
  expect(html).toContain('per-category');
  expect(html).toContain('Corrections &amp; provenance');
});
it('renders validated allocation target/actual drift with fixed and excluded holdings', () => {
  const now = new Date().toISOString(),
    holding = (id: string, minor: number) => ({
      id,
      name: id,
      section: 'asset',
      code: id,
      subcode: '',
      valuation: { minor, currency: 'SGD' },
      profit: null,
      costBasis: null,
      returnPercent: null,
      flags: [],
    });
  const snapshot = {
    id: 'portfolio',
    accountId: 'account',
    accountType: 'cash',
    provenance: { provider: 'fsm', capturedAt: now, source: 'fixture', complete: false, flags: [] },
    holdings: [holding('target', 10000), holding('fixed', 20000), holding('excluded', 30000)],
  };
  const html = renderToStaticMarkup(
    createElement(FinancialViews, {
      values: [snapshot],
      settings: {
        allocations: {
          scopes: [
            {
              id: 'scope',
              bucket: 'Retirement',
              accountId: 'account',
              accountType: 'cash',
              currency: 'SGD',
              section: 'asset',
              targets: {
                target: { targetBps: 5000 },
                fixed: { fixed: true },
                excluded: { excluded: true },
              },
            },
          ],
        },
      },
    }),
  ).replace(/<!--.*?-->/g, '');
  expect(html).toContain('Retirement · target versus actual');
  expect(html).toContain('300.00');
  expect(html).toContain('150.00');
  expect(html).toContain('Fixed');
  expect(html).toContain('Excluded');
  expect(html).toContain('Drift bps');
});
it('suppresses exact remaining/eligible claims for ambiguous Maybank windows', () => {
  const now = new Date().toISOString(),
    capture: CardCapture = {
      id: 'maybank',
      accountId: 'bound',
      card: 'maybank-xl',
      persistence: 'account-bound',
      provenance: {
        provider: 'maybank',
        capturedAt: now,
        source: 'fixture',
        complete: false,
        flags: ['SNAPSHOT_LOCAL_IDENTITY_AMBIGUITY'],
      },
      transactions: [
        {
          id: 'local',
          identityConfidence: 'snapshot-local',
          reference: 'synthetic',
          postingDate: now.slice(0, 10),
          transactionDate: null,
          merchant: 'Fixture merchant SGP',
          spending: { currency: 'SGD', minor: 10000 },
        },
      ],
    };
  const html = renderToStaticMarkup(
    createElement(FinancialViews, {
      values: [capture],
      settings: {},
      bankSettings: { cards: { bound: { selectedCategories: ['Local'] } } },
    }),
  );
  expect(html).toContain('lower bound');
  expect(html).toContain('remaining amounts are unknown');
  expect(html).not.toContain('remaining SGD');
  expect(html).not.toContain('reference eligible SGD');
});
