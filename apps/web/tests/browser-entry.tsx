import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  FinanceClient,
  browserTransport,
  browserCoordinator,
  indexedStorage,
} from '@finance-tools/client';
import { createVault, encryptJson } from '@finance-tools/crypto';
import { App } from '../src/App';
import {
  setClerkLoaded,
  setClerkUser,
  configureVerification,
  verificationState,
  resolveSecond,
} from './clerk-fixture';
const client = new FinanceClient(
  browserTransport(`${location.origin}/api/v1`),
  indexedStorage,
  'browser',
  browserCoordinator,
);
const root = createRoot(document.getElementById('root')!);
Object.assign(window, {
  fixture: {
    loadId: crypto.randomUUID(),
    mount: () => root.render(<App client={client} storage={indexedStorage} />),
    clerk: setClerkUser,
    clerkLoaded: setClerkLoaded,
    verification: configureVerification,
    verificationState,
    resolveSecond,
    state: () => ({ accountId: client.me?.accountId, unlocked: client.unlocked }),
    remembered: async () => !!(await indexedStorage.get('remembered')),
    seed: async () => {
      const prepared = await createVault('acct-a', 'test-only-long-passphrase');
      const now = new Date().toISOString();
      const envelope = await encryptJson(
        prepared.vaultKey,
        {
          id: 'history-a',
          accountId: 'provider-account',
          accountType: 'cash',
          provenance: {
            provider: 'fsm',
            capturedAt: now,
            source: 'browser-test-fixture',
            complete: false,
            flags: ['owned-decrypted-snapshot'],
          },
          holdings: [
            {
              id: 'holding-a',
              name: 'Fixture holding',
              code: 'fund',
              subcode: '',
              section: 'asset',
              valuation: { currency: 'SGD', minor: 10000 },
              profit: null,
              costBasis: null,
              returnPercent: null,
              flags: [],
            },
          ],
        },
        {
          accountId: 'acct-a',
          namespace: 'history',
          documentId: 'history-a',
          schemaVersion: 1,
          keyVersion: 1,
        },
      );
      const settingsEnvelope = await encryptJson(
        prepared.vaultKey,
        {
          allocations: {
            scopes: [
              {
                id: 'allocation',
                bucket: 'Browser allocation',
                accountId: 'provider-account',
                accountType: 'cash',
                currency: 'SGD',
                section: 'asset',
                targets: { 'holding-a': { targetBps: 5000 } },
              },
            ],
          },
          cards: {},
        },
        {
          accountId: 'acct-a',
          namespace: 'settings',
          documentId: 'current_portfolio',
          schemaVersion: 1,
          keyVersion: 1,
        },
      );
      await fetch('/fixture/seed', {
        method: 'POST',
        body: JSON.stringify({
          vault: { revision: 1, vault: prepared.vault },
          doc: {
            id: 'history-a',
            namespace: 'history',
            product: 'portfolio',
            revision: 1,
            envelope,
            occurredAt: now,
            updatedAt: now,
          },
          settingsDoc: {
            id: 'current_portfolio',
            namespace: 'settings',
            product: 'portfolio',
            revision: 1,
            envelope: settingsEnvelope,
            updatedAt: now,
          },
        }),
      });
      await indexedStorage.set('remembered', {
        accountId: 'acct-a',
        keyVersion: 1,
        key: prepared.vaultKey,
      });
      await indexedStorage.set('identity-binding', { clerkSubject: 'user-a', accountId: 'acct-a' });
    },
  },
});
