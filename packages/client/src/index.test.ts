import { describe, expect, it, vi } from 'vitest';
import {
  ApiFailure,
  FinanceClient,
  browserTransport,
  calendarCutoff,
  canonical,
  mergeSettings,
  mergeSnapshots,
} from './index';
import type { Storage, Transport } from './index';
import { snapshotFixture } from './fixtures';
function memory(): Storage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
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
}
const token = (accountId: string) =>
  `e30.${btoa(JSON.stringify({ sub: accountId, sid: 'session' })).replace(/=/g, '')}.signature`;
const tokens = {
  accessToken: token('account'),
  expiresIn: 900,
  sessionId: 'session',
  refreshToken: 'opaque-next',
};
describe('private client', () => {
  it('singleflights refresh within a tab and rotates only opaque GM credentials', async () => {
    const storage = memory();
    await storage.set('refresh', 'opaque-old');
    let refreshes = 0;
    const transport: Transport = async (path, _method, body, token) => {
      if (path === '/session/refresh') {
        refreshes++;
        expect(body).toEqual({ refreshToken: 'opaque-old' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 200, body: tokens };
      }
      expect(token).toBe(tokens.accessToken);
      return { status: 200, body: { ok: true } };
    };
    const client = new FinanceClient(transport, storage, 'userscript');
    await Promise.all([client.request('/a'), client.request('/b')]);
    expect(refreshes).toBe(1);
    expect(await storage.get('refresh')).toBe('opaque-next');
    expect([...storage.values.values()]).not.toContain(tokens.accessToken);
  });
  it('clears remembered keys and credentials on revoked refresh', async () => {
    const storage = memory();
    await storage.set('refresh', 'opaque');
    await storage.set('remembered', { accountId: 'old-account', keyVersion: 1 });
    const client = new FinanceClient(
      async () => ({ status: 401, body: { error: { code: 'revoked' } } }),
      storage,
      'userscript',
    );
    const lock = vi.fn();
    client.onLock = lock;
    await expect(client.request('/me')).rejects.toBeInstanceOf(ApiFailure);
    expect(storage.values.size).toBe(0);
    expect(lock).toHaveBeenCalled();
    expect(client.me).toBeUndefined();
  });
  it('removes remembered material when account binding differs', async () => {
    const storage = memory();
    await storage.set('refresh', 'opaque');
    await storage.set('remembered', { accountId: 'previous', keyVersion: 1 });
    const client = new FinanceClient(
      async (path) => ({
        status: path === '/vault' ? 404 : 200,
        body:
          path === '/session/refresh'
            ? { ...tokens, accessToken: token('current') }
            : {
                accountId: 'current',
                namespaces: ['settings', 'history'],
                products: ['portfolio', 'bank-subcaps'],
              },
      }),
      storage,
      'userscript',
    );
    await client.initialize();
    expect(client.me?.accountId).toBe('current');
    expect(client.unlocked).toBe(false);
    expect(await storage.get('remembered')).toBeUndefined();
  });
  it('locks synchronously and invalidates in-flight decrypted views', async () => {
    const storage = memory();
    const client = new FinanceClient(async () => ({ status: 200, body: {} }), storage, 'browser');
    const old = client.lockEpoch;
    const locked = vi.fn();
    client.onLock = locked;
    await storage.set('remembered', 'key');
    const done = client.lock();
    expect(client.lockEpoch).toBe(old + 1);
    expect(locked).toHaveBeenCalled();
    await done;
    expect(await storage.get('remembered')).toBeUndefined();
  });
  it('uses exact browser CSRF header, own bearer and included cookies', async () => {
    const fetchMock = vi.fn(async () => ({ status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await browserTransport('https://finance.example/api/v1')(
        '/vault',
        'PUT',
        { mutationId: 'id' },
        'own',
      );
      const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://finance.example/api/v1/vault');
      expect(options.credentials).toBe('include');
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        'X-Finance-CSRF': '1',
        Authorization: 'Bearer own',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('clamps calendar-month retention and canonicalizes object keys', () => {
    expect(calendarCutoff(new Date('2026-05-31T12:34:56Z')).toISOString()).toBe(
      '2026-02-28T12:34:56.000Z',
    );
    expect(canonical({ z: 1, a: { b: 2, a: 3 } })).toBe(canonical({ a: { a: 3, b: 2 }, z: 1 }));
  });
  it('merges independent nested edits and refuses divergent same-field edits', () => {
    expect(
      mergeSettings(
        { assignments: { a: 'old', b: 'old' } },
        { assignments: { a: 'remote', b: 'old' } },
        { assignments: { a: 'old', b: 'local' } },
      ),
    ).toEqual({ assignments: { a: 'remote', b: 'local' } });
    expect(() => mergeSettings({ a: 0 }, { a: 1 }, { a: 2 })).toThrow('same setting');
  });
  it('merges append-only transaction snapshots by ID without overwriting changed records', () => {
    const base = {
      id: 'snapshot',
      accountId: 'provider-account',
      card: 'card',
      provenance: {
        provider: 'bank',
        capturedAt: '2026-10-04T00:00:00Z',
        complete: false,
        flags: [],
      },
    };
    const remote = { ...base, transactions: [{ id: 'a', minor: 100 }] },
      local = { ...base, transactions: [{ id: 'b', minor: 200 }] };
    expect(mergeSnapshots(remote, local)).toMatchObject({
      transactions: [
        { id: 'a', minor: 100 },
        { id: 'b', minor: 200 },
      ],
      provenance: { complete: false, flags: ['CLIENT_CONFLICT_MERGE'] },
    });
    expect(() =>
      mergeSnapshots(remote, { ...base, transactions: [{ id: 'a', minor: 999 }] }),
    ).toThrow('same transaction');
  });
  it('persists encrypted canonical mutations across network retries without financial plaintext', async () => {
    const now = new Date().toISOString();
    const storage = memory();
    await storage.set('refresh', 'opaque');
    let vault: unknown,
      fail = true;
    const writes: unknown[] = [];
    const transport: Transport = async (path, method, body) => {
      if (path === '/session/refresh') return { status: 200, body: tokens };
      if (path === '/me')
        return {
          status: 200,
          body: {
            accountId: 'account',
            namespaces: ['settings', 'history'],
            products: ['portfolio', 'bank-subcaps'],
          },
        };
      if (path === '/vault' && method === 'GET') return { status: 404, body: {} };
      if (path === '/vault') {
        vault = (body as { vault: unknown }).vault;
        return { status: 200, body: { revision: 1, vault } };
      }
      writes.push(body);
      if (fail) {
        fail = false;
        throw new Error('offline');
      }
      const request = body as { envelope: unknown };
      return {
        status: 200,
        body: {
          id: 'snapshot',
          namespace: 'history',
          product: 'portfolio',
          envelope: request.envelope,
          revision: 1,
          occurredAt: now,
          updatedAt: now,
        },
      };
    };
    const client = new FinanceClient(transport, storage, 'userscript');
    await client.initialize();
    const prepared = await client.prepareVault('long-private-passphrase');
    await client.finishVault(prepared);
    const value = {
      ...snapshotFixture(now),
      holdings: [
        {
          id: 'holding',
          name: 'private financial merchant',
          code: 'fund',
          subcode: '',
          section: 'asset' as const,
          valuation: { currency: 'SGD', minor: 12345678 },
          profit: null,
          costBasis: null,
          returnPercent: null,
          flags: [],
        },
      ],
    };
    await expect(client.put('history', 'snapshot', value, 0, now)).rejects.toThrow('offline');
    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      'private financial merchant',
    );
    expect(JSON.stringify([...storage.values.values()])).not.toContain('12345678');
    const stored = await client.put(
      'history',
      'snapshot',
      {
        provenance: value.provenance,
        holdings: value.holdings,
        accountId: value.accountId,
        id: value.id,
      },
      0,
      now,
    );
    expect(writes[0]).toEqual(writes[1]);
    expect(await client.decrypt(stored)).toEqual(value);
    await client.lock();
    await expect(client.decrypt(stored)).rejects.toThrow('Unlock first');
  });
});
