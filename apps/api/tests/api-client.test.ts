import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { FinanceClient, browserTransport } from '@finance-tools/client';
import type { Storage, Transport } from '@finance-tools/client';
import type { PairingResponse, SessionInfo, StoredDocument } from '@finance-tools/contracts';
import { key, random } from '../src/security';

const ORIGIN = 'https://finance.laurenceputra.com';
let mf: Miniflare, env: Env, privateKey: CryptoKey;
let browserCookie = '',
  loseBrowser = '',
  loseGM = '';
const gmRequests: { path: string; headers: Headers; body: unknown }[] = [];
const browserRequests: { path: string; headers: Headers }[] = [];
function storage(): Storage {
  const values = new Map<string, unknown>();
  return {
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
async function clerk(subject = 'user_client') {
  const time = Math.floor(Date.now() / 1000);
  return new SignJWT({ azp: ORIGIN, sid: 'sess_clerk', v: 2, fva: [0, -1], nbf: time - 5 })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'test' })
    .setSubject(subject)
    .setIssuer(env.CLERK_ISSUER)
    .setAudience(env.CLERK_AUDIENCE)
    .setIssuedAt(time)
    .setExpirationTime(time + 600)
    .sign(privateKey);
}
// Simulates the browser's cookie/Origin machinery, not application transport:
// FinanceClient uses the actual browserTransport, including its credential,
// CSRF and retry-ID headers. Only the network destination is local workerd.
async function browserFetch(input: string | URL | Request, init: RequestInit = {}) {
  expect(init.credentials).toBe('include');
  const url = String(input),
    path = new URL(url).pathname.replace('/api/v1', '');
  const headers = new Headers(init.headers);
  headers.set('Origin', ORIGIN);
  if (browserCookie) headers.set('Cookie', browserCookie);
  browserRequests.push({ path, headers });
  const response = await mf.dispatchFetch(url, {
    method: init.method,
    headers,
    body: init.body as string | undefined,
  });
  if (loseBrowser === path) {
    loseBrowser = '';
    await response.arrayBuffer();
    throw new Error('Response lost after commit');
  }
  const cookie = response.headers.get('Set-Cookie');
  if (cookie) browserCookie = cookie.includes('Max-Age=0') ? '' : cookie.split(';')[0];
  return response;
}
// The real FinanceClient userscript transport contract over GM's anonymous
// request semantics: no browser cookie jar, explicit refresh JSON, and headers
// forwarded exactly like runtime.ts's GM_xmlhttpRequest adapter.
const gmTransport: Transport = async (path, method, body, token, extra) => {
  const headers = new Headers({
    ...extra,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  expect(headers.has('Cookie')).toBe(false);
  gmRequests.push({ path, headers, body });
  const response = await mf.dispatchFetch(ORIGIN + '/api/v1' + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (loseGM === path) {
    loseGM = '';
    await response.arrayBuffer();
    throw new Error('Response lost after commit');
  }
  return {
    status: response.status,
    body: response.status === 204 ? undefined : await response.json(),
  };
};
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const bindings = {
    APP_ORIGIN: ORIGIN,
    CLERK_ISSUER: 'https://test.clerk.accounts.dev',
    CLERK_AUDIENCE: 'finance-test',
    CLERK_JWT_KEY: await exportSPKI(pair.publicKey),
    CLERK_SECRET_KEY: 'sk_test_example',
    CLERK_PUBLISHABLE_KEY: 'pk_test_example',
    ACCESS_JWT_SECRET: random(),
    SESSION_WRAP_SECRET: random(),
    CLERK_WEBHOOK_SECRET: 'whsec_' + btoa('x'.repeat(32)),
  };
  const bundle = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    external: ['node:*'],
  });
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-10-04',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'client' },
    r2Buckets: { BLOBS: 'client' },
    bindings,
    outboundService: async (req) =>
      Response.json({
        object: 'user',
        id: new URL(req.url).pathname.split('/').pop(),
        two_factor_enabled: false,
        banned: false,
        updated_at: Date.now(),
      }),
  });
  env = {
    DB: await mf.getD1Database('DB'),
    BLOBS: await mf.getR2Bucket('BLOBS'),
    ...bindings,
  } as unknown as Env;
  const migration = await readFile(
    new URL('../migrations/0001_initial.sql', import.meta.url),
    'utf8',
  );
  const [tables, ...triggers] = migration.replace(/--[^\n]*/g, '').split('CREATE TRIGGER');
  await env.DB.batch(
    tables
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => env.DB.prepare(s)),
  );
  for (const trigger of triggers) await env.DB.prepare('CREATE TRIGGER' + trigger).run();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await mf?.dispose();
});
beforeEach(async () => {
  await env.DB.batch(
    [
      'commands',
      'mutations',
      'documents',
      'refresh_history',
      'pairings',
      'sessions',
      'blobs',
      'accounts',
      'rate_limits',
      'webhooks',
      'cleanup_state',
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  const page = await env.BLOBS.list();
  if (page.objects.length) await env.BLOBS.delete(page.objects.map((o) => o.key));
  browserCookie = '';
  loseBrowser = '';
  loseGM = '';
  gmRequests.length = 0;
  browserRequests.length = 0;
  vi.stubGlobal('fetch', browserFetch);
});
async function pair(
  browser: FinanceClient,
  product: 'portfolio' | 'bank-subcaps',
  name: string,
  loseRedeem = false,
) {
  const credentials = await gmTransport('/pairing/create', 'POST', {
    client: { kind: 'userscript', name, namespaces: ['settings', 'history'], products: [product] },
  });
  expect(credentials.status).toBe(201);
  const p = credentials.body as PairingResponse;
  const inspect = await browser.request<{ client: { products: string[]; name: string } }>(
    '/pairing/inspect',
    'POST',
    { pairingId: p.pairingId, code: p.code },
  );
  expect(inspect.client.name).toBe(name);
  expect(inspect.client.products).toEqual([product]);
  await browser.request('/pairing/approve', 'POST', { pairingId: p.pairingId, code: p.code });
  const gm = storage(),
    script = new FinanceClient(gmTransport, gm, 'userscript', undefined, [product]);
  if (loseRedeem) {
    loseGM = '/pairing/redeem';
    await expect(script.redeem(p.pairingId, p.secret)).rejects.toThrow('Response lost');
    expect(await gm.get('refresh')).toBeUndefined();
  }
  await script.redeem(p.pairingId, p.secret);
  return { script, gm };
}

it('integrates browser cookies and anonymous GM credentials through vault, pairing, product CRUD, refresh loss recovery, export and session revocation', async () => {
  const browser = new FinanceClient(browserTransport(), storage(), 'browser');
  await browser.exchange(await clerk());
  expect(browser.me?.products).toEqual(['portfolio', 'bank-subcaps']);
  expect(browserCookie).toContain('__Host-finance-refresh=');
  const prepared = await browser.prepareVault('test passphrase');
  await browser.finishVault(prepared);
  const portfolio = await pair(browser, 'portfolio', 'Portfolio script', true),
    bank = await pair(browser, 'bank-subcaps', 'Bank script');
  await portfolio.script.unlock(prepared.recoverySecret, true);
  await bank.script.unlock(prepared.recoverySecret, true);
  loseGM = '/documents/settings/portfolio_settings';
  await expect(
    portfolio.script.put('settings', 'portfolio_settings', { favourite: 'private portfolio' }, 0),
  ).rejects.toThrow('Response lost');
  const portfolioDoc = await portfolio.script.put(
    'settings',
    'portfolio_settings',
    { favourite: 'private portfolio' },
    0,
  );
  expect(portfolioDoc.revision).toBe(1);
  expect(
    (await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mutations WHERE document_id='portfolio_settings'",
    ).first<{ count: number }>())!.count,
  ).toBe(1);
  const bankDoc = await bank.script.put(
    'settings',
    'bank_settings',
    { favourite: 'private bank' },
    0,
  );
  expect(portfolioDoc.product).toBe('portfolio');
  expect(bankDoc.product).toBe('bank-subcaps');
  expect(await browser.decrypt(portfolioDoc)).toEqual({ favourite: 'private portfolio' });
  await expect(bank.script.request('/documents/settings/portfolio_settings')).rejects.toMatchObject(
    { status: 403, code: 'product_scope' },
  );
  expect((await portfolio.script.all('settings')).map((d) => d.id)).toEqual(['portfolio_settings']);
  expect((await bank.script.all('settings')).map((d) => d.id)).toEqual(['bank_settings']);
  expect((await browser.all('settings')).map((d) => d.id)).toEqual([
    'bank_settings',
    'portfolio_settings',
  ]);
  const oldGM = await portfolio.gm.get<string>('refresh');
  loseGM = '/session/refresh';
  await expect(portfolio.script.refresh()).rejects.toThrow('Response lost');
  expect(await portfolio.gm.get('refresh')).toBe(oldGM);
  const pendingGM = await portfolio.gm.get<{ id: string }>('refresh-attempt');
  expect(pendingGM?.id).toBeTruthy();
  await portfolio.script.refresh();
  expect(await portfolio.gm.get('refresh')).not.toBe(oldGM);
  expect(await portfolio.gm.get('refresh-attempt')).toBeUndefined();
  const gmRefreshes = gmRequests.filter((r) => r.path === '/session/refresh');
  expect(gmRefreshes[0].headers.get('X-Finance-Refresh-Id')).toBe(
    gmRefreshes[1].headers.get('X-Finance-Refresh-Id'),
  );
  const restarted = new FinanceClient(gmTransport, portfolio.gm, 'userscript', undefined, [
    'portfolio',
  ]);
  await restarted.initialize();
  expect(restarted.me?.products).toEqual(['portfolio']);
  const oldCookie = browserCookie;
  loseBrowser = '/session/refresh';
  await expect(browser.refresh()).rejects.toThrow('Response lost');
  expect(browserCookie).toBe(oldCookie);
  await browser.refresh();
  expect(browserCookie).not.toBe(oldCookie);
  const browserRefreshes = browserRequests.filter((r) => r.path === '/session/refresh');
  expect(browserRefreshes[0].headers.get('X-Finance-Refresh-Id')).toBe(
    browserRefreshes[1].headers.get('X-Finance-Refresh-Id'),
  );
  const day = new Date().toISOString().slice(0, 10);
  const bankValue = {
    id: 'capture',
    accountId: 'bound-account',
    persistence: 'account-bound',
    card: 'maybank-xl',
    provenance: {
      provider: 'maybank',
      capturedAt: new Date().toISOString(),
      source: 'integration',
      complete: false,
      flags: [],
    },
    transactions: [
      {
        id: 'txn1',
        reference: 'one',
        postingDate: day,
        transactionDate: day,
        merchant: 'private integration merchant',
        spending: { minor: 2500, currency: 'SGD' },
      },
    ],
  };
  const history = await bank.script.put(
    'history',
    'bank_history',
    bankValue,
    0,
    `${day}T00:00:00.000Z`,
  );
  expect(await bank.script.decrypt(history)).toEqual(bankValue);
  const exported = await browser.encryptedExport();
  expect(exported.documents).toHaveLength(3);
  expect(JSON.stringify(exported)).not.toContain('private bank');
  expect(JSON.stringify(exported)).not.toContain('private integration merchant');
  await expect(bank.script.encryptedExport()).rejects.toMatchObject({ status: 403 });
  const sessions = await browser.request<{ sessions: SessionInfo[] }>('/sessions');
  expect(sessions.sessions.filter((s) => s.client.name === 'Portfolio script')).toHaveLength(1);
  const current = sessions.sessions.find((s) => s.current)!;
  const seconds = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({
    sid: current.id,
    scopes: ['settings', 'history'],
    products: ['portfolio', 'bank-subcaps'],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ORIGIN)
    .setAudience('finance-tools-api-v1')
    .setSubject(browser.me!.accountId)
    .setIssuedAt(seconds - 901)
    .setExpirationTime(seconds - 1)
    .setJti(random(16))
    .sign(key(env.ACCESS_JWT_SECRET));
  const normal = browser.transport;
  let expireOnce = true;
  browser.transport = (path, method, body, token, headers) => {
    if (path === '/me' && expireOnce) {
      expireOnce = false;
      return normal(path, method, body, expired, headers);
    }
    return normal(path, method, body, token, headers);
  };
  expect((await browser.request<{ accountId: string }>('/me')).accountId).toBe(
    browser.me!.accountId,
  );
  expect(browser.unlocked).toBe(true);
  const portfolioSession = sessions.sessions.find((s) => s.client.name === 'Portfolio script')!;
  await browser.request('/sessions/' + portfolioSession.id, 'DELETE');
  await expect(portfolio.script.refresh()).rejects.toMatchObject({ status: 401 });
  expect(await portfolio.gm.get('refresh')).toBeUndefined();
  expect(portfolio.script.unlocked).toBe(false);
  const keptCookie = browserCookie;
  await bank.script.disconnect();
  expect(browserCookie).toBe(keptCookie);
  await browser.request('/documents/settings/portfolio_settings', 'DELETE', {
    expectedRevision: 1,
    mutationId: crypto.randomUUID(),
  });
  await expect(browser.request('/documents/settings/portfolio_settings')).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    browser.put('settings', 'portfolio_settings', { reset: true }, 0),
  ).rejects.toMatchObject({ status: 409 });
  const recreated: StoredDocument = await browser.put(
    'settings',
    'portfolio_settings',
    { reset: true },
    2,
  );
  expect(recreated.revision).toBe(3);
  await browser.disconnect(true);
  expect(browserCookie).toBe('');
  expect(browser.unlocked).toBe(false);
}, 30000);

it('integrates vault rewrap, delete step-up/retry and irreversible account revocation', async () => {
  const transport = browserTransport(),
    browser = new FinanceClient(transport, storage(), 'browser');
  await browser.exchange(await clerk());
  const prepared = await browser.prepareVault('first passphrase');
  await browser.finishVault(prepared);
  await browser.put('settings', 'a', { secret: 'never plaintext on API' }, 0);
  await browser.rewrap('first passphrase', 'new passphrase');
  await browser.lock();
  await browser.unlock('new passphrase');
  expect(await browser.decrypt((await browser.all('settings'))[0])).toEqual({
    secret: 'never plaintext on API',
  });
  const proof = { clerkToken: await clerk(), confirmation: 'DELETE' };
  await browser.request('/account', 'DELETE', proof);
  expect(browserCookie).toBe('');
  const retry = await transport('/account', 'DELETE', proof);
  expect(retry.status).toBe(204);
  await expect(browser.request('/me')).rejects.toMatchObject({ status: 401 });
  expect(browser.unlocked).toBe(false);
  await expect(browser.exchange(await clerk())).rejects.toMatchObject({
    status: 403,
    code: 'account_deleted',
  });
}, 30000);

it('cancels an old-account ciphertext mutation when browser-cookie refresh changes principal', async () => {
  const first = new FinanceClient(browserTransport(), storage(), 'browser');
  await first.exchange(await clerk());
  const a = await first.prepareVault('first account secret');
  await first.finishVault(a);
  await first.put('settings', 'shared', { value: 'first account' }, 0);
  const originalId = first.me!.accountId;
  const firstSession = await env.DB.prepare('SELECT id FROM sessions WHERE account_id=?')
    .bind(originalId)
    .first<{ id: string }>();
  // Another tab switches the shared HttpOnly cookie to a different account,
  // while this tab still holds the first account's memory key and me response.
  const second = new FinanceClient(browserTransport(), storage(), 'browser');
  await second.exchange(await clerk('user_other'));
  const b = await second.prepareVault('second account secret');
  await second.finishVault(b);
  await second.put('settings', 'shared', { value: 'second account' }, 0);
  const time = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({ sid: firstSession!.id })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ORIGIN)
    .setAudience('finance-tools-api-v1')
    .setSubject(originalId)
    .setIssuedAt(time - 901)
    .setExpirationTime(time - 1)
    .setJti(random(16))
    .sign(key(env.ACCESS_JWT_SECRET));
  const normal = first.transport;
  let expiredOnce = true;
  first.transport = (path, method, body, token, headers) => {
    if (method === 'PUT' && expiredOnce) {
      expiredOnce = false;
      return normal(path, method, body, expired, headers);
    }
    return normal(path, method, body, token, headers);
  };
  await expect(
    first.put('settings', 'shared', { value: 'wrong-account pending write' }, 1),
  ).rejects.toThrow();
  expect(first.unlocked).toBe(false);
  const current = await second.request<StoredDocument>('/documents/settings/shared');
  expect(current.revision).toBe(1);
  expect(await second.decrypt(current)).toEqual({ value: 'second account' });
}, 30000);
