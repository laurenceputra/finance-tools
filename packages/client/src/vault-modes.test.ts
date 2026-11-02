import { expect, it } from 'vitest';
import { FinanceClient } from './index';
import type { Storage, Transport } from './index';
import { createVault, encodeBase64url, unwrapVaultKey } from '@finance-tools/crypto';

function setup() {
  const values = new Map<string, unknown>();
  const storage: Storage = {
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
  const rawKey = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  let releases = 0;
  const transport: Transport = async (path) => {
    if (path === '/session/refresh')
      return {
        status: 200,
        body: {
          accessToken: `e30.${btoa(JSON.stringify({ sub: 'account', sid: 'session' }))}.signature`,
          sessionId: 'session',
          expiresIn: 900,
        },
      };
    if (path === '/me')
      return {
        status: 200,
        body: {
          accountId: 'account',
          namespaces: ['settings', 'history'],
          products: ['portfolio', 'bank-subcaps'],
        },
      };
    if (path === '/vault')
      return {
        status: 200,
        body: { revision: 1, vault: { version: 2, mode: 'standard', keyVersion: 1 } },
      };
    if (path === '/vault/key') {
      releases++;
      return { status: 200, body: { revision: 1, keyVersion: 1, rawKey } };
    }
    return { status: 204, body: undefined };
  };
  return {
    client: new FinanceClient(transport, storage, 'browser'),
    transport,
    values,
    rawKey,
    releases: () => releases,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it('does not persist Standard raw keys and respects an explicit lock across later initialization', async () => {
  const { client, releases, values, rawKey } = setup();
  await client.initialize();
  expect(client.unlocked).toBe(true);
  expect(releases()).toBe(1);
  expect(JSON.stringify([...values.values()])).not.toContain(rawKey);
  await client.lock();
  await client.initialize();
  expect(client.unlocked).toBe(false);
  expect(releases()).toBe(1);
  await client.unlockStandard();
  expect(client.unlocked).toBe(true);
});

it('fences a late server key release after Lock or disconnect', async () => {
  for (const disconnect of [false, true]) {
    const { client, transport } = setup();
    const entered = deferred<void>(),
      release = deferred<void>();
    client.transport = async (...args) => {
      if (args[0] === '/vault/key') {
        entered.resolve();
        await release.promise;
      }
      return transport(...args);
    };
    const initializing = client.initialize();
    await entered.promise;
    if (disconnect) await client.disconnect();
    else await client.lock();
    release.resolve();
    await expect(initializing).rejects.toThrow('cancelled');
    expect(client.unlocked).toBe(false);
  }
});

it('clears Standard views and remembered keys when a remote mode revision changes, without auto-unlocking', async () => {
  const { client, transport, values } = setup();
  await client.initialize();
  values.set('remembered', { accountId: 'account', keyVersion: 1, key: {} });
  const privateVault = await createVault('account', 'private-passphrase');
  client.transport = async (...args) =>
    args[0] === '/vault'
      ? {
          status: 200,
          body: { revision: 2, vault: { ...privateVault.vault, version: 2, mode: 'private' } },
        }
      : transport(...args);
  let locks = 0;
  client.onLock = () => {
    locks++;
  };
  await client.initialize();
  expect(client.unlocked).toBe(false);
  expect(values.has('remembered')).toBe(false);
  expect(locks).toBe(1);
});

it('never applies a late mode-commit response after an explicit lock', async () => {
  const { client, transport } = setup();
  await client.initialize();
  const prepared = await client.preparePrivate('private-passphrase');
  const entered = deferred<void>(),
    release = deferred<void>();
  client.transport = async (...args) => {
    if (args[0] === '/vault/mode') {
      entered.resolve();
      await release.promise;
      return { status: 200, body: { revision: 2, vault: prepared.vault } };
    }
    return transport(...args);
  };
  const changing = client.finishPrivate(prepared, 'fresh-clerk-proof');
  await entered.promise;
  await client.lock();
  release.resolve();
  await expect(changing).rejects.toThrow('cancelled');
  expect(client.unlocked).toBe(false);
  expect(client.vault?.revision).toBe(1);
});

it('discards a failed account-A mode intent on principal change and never reuses its raw key for account B', async () => {
  const a = await createVault('account-a', 'passphrase-a'),
    b = await createVault('account-b', 'passphrase-b');
  let account = 'account-a';
  const bodies: { rawKey: string }[] = [];
  const { values } = setup();
  const storage: Storage = {
    async get<T>(name: string) {
      return values.get(name) as T | undefined;
    },
    async set(name, value) {
      values.set(name, value);
    },
    async delete(name) {
      values.delete(name);
    },
  };
  const transport: Transport = async (path, _method, body) => {
    if (path === '/session/refresh')
      return {
        status: 200,
        body: {
          accessToken: `e30.${encodeBase64url(new TextEncoder().encode(JSON.stringify({ sub: account, sid: 'session' })))}.signature`,
          sessionId: 'session',
          expiresIn: 900,
        },
      };
    if (path === '/me')
      return {
        status: 200,
        body: {
          accountId: account,
          clerkSubject: account,
          namespaces: ['settings'],
          products: ['portfolio'],
        },
      };
    if (path === '/vault')
      return {
        status: 200,
        body: { revision: 1, vault: account === 'account-a' ? a.vault : b.vault },
      };
    if (path === '/vault/mode') {
      const input = body as { rawKey: string; vault: unknown };
      bodies.push(input);
      return bodies.length === 1
        ? { status: 503, body: { error: { code: 'transient' } } }
        : { status: 200, body: { revision: 2, vault: input.vault } };
    }
    throw new Error('Unexpected request');
  };
  const client = new FinanceClient(transport, storage, 'browser');
  await client.initialize();
  await client.unlock('passphrase-a');
  await expect(client.enableStandard('passphrase-a', false, 'proof-a', true)).rejects.toMatchObject(
    { status: 503 },
  );
  // Pending response-loss state must still authenticate the supplied retry credential.
  await expect(client.enableStandard('wrong-credential', false, 'proof-a', true)).rejects.toThrow();
  expect(bodies).toHaveLength(1);
  account = 'account-b';
  await expect(client.refresh()).rejects.toThrow('Session account changed');
  expect(client.unlocked).toBe(false);
  await client.initialize();
  await client.unlock('passphrase-b');
  await client.enableStandard('passphrase-b', false, 'proof-b', true);
  const raw = await unwrapVaultKey('account-b', b.vault, 'passphrase-b');
  try {
    expect(bodies[1].rawKey).toBe(encodeBase64url(raw));
    expect(bodies[1].rawKey).not.toBe(bodies[0].rawKey);
  } finally {
    raw.fill(0);
  }
});

it('checks authoritative identity before key release or remembered-key restoration', async () => {
  const { client, releases } = setup();
  await expect(
    client.initialize(() => {
      throw new Error('identity conflict');
    }),
  ).rejects.toThrow('identity conflict');
  expect(releases()).toBe(0);
  expect(client.unlocked).toBe(false);
  expect(client.me).toBeUndefined();
});

for (const endpoint of ['/vault/mode', '/account'] as const) {
  for (const phase of ['initial', '401-retry'] as const) {
    it(`cancels ${endpoint} during ${phase} refresh before any subsequent sensitive transport submission`, async () => {
      const original = setup();
      await original.client.initialize();
      const prepared =
        endpoint === '/vault/mode'
          ? await original.client.preparePrivate('private-passphrase')
          : undefined;
      const client =
        phase === 'initial'
          ? new FinanceClient(original.transport, original.client.storage, 'browser')
          : original.client;
      // Model restored account metadata with an absent in-memory access token.
      if (phase === 'initial') {
        client.me = original.client.me;
        client.vault = original.client.vault;
      }
      const entered = deferred<void>(),
        release = deferred<void>();
      let current = true,
        submissions = 0;
      const assertCurrent = () => {
        if (!current) throw new Error('Intent cancelled');
      };
      client.transport = async (...args) => {
        if (args[0] === '/session/refresh') {
          entered.resolve();
          await release.promise;
          return original.transport(...args);
        }
        if (args[0] === endpoint) {
          submissions++;
          return { status: 401, body: { error: { code: 'expired' } } };
        }
        return original.transport(...args);
      };
      const action = prepared
        ? client.finishPrivate(prepared, 'fresh-proof', assertCurrent)
        : client.request(
            '/account',
            'DELETE',
            { clerkToken: 'fresh-proof', confirmation: 'DELETE' },
            assertCurrent,
          );
      await entered.promise;
      current = false;
      release.resolve();
      await expect(action).rejects.toThrow('Intent cancelled');
      expect(submissions).toBe(phase === 'initial' ? 0 : 1);
      expect(client.vault?.revision).toBe(1);
    });
  }
}
