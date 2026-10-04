import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { build } from 'esbuild';
import { Webhook } from 'svix';
import { encodeBase64url } from '@finance-tools/crypto';
import { MAX_REQUEST_BODY_BYTES, MAX_DOCUMENT_BYTES } from '@finance-tools/contracts';
import { accessToken, hash, historyCutoff, random } from '../src/security';
import { insertSession, newSession } from '../src/sessions';
import { cleanup } from '../src/lifecycle';
import type { Client, Session } from '../src/security';

const ORIGIN = 'https://finance.laurenceputra.com';
let mf: Miniflare, env: Env, privateKey: CryptoKey, mfaEnabled = false, clerkBanned = false, clerkUpdatedAt = 0;
let browserSession: Session, browserAccess: string, scriptSession: Session, scriptAccess: string, scriptRefresh: string;
const encrypted = { algorithm: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA', schemaVersion: 1, keyVersion: 1 };
const wrapped = { ...encrypted, ciphertext: 'A'.repeat(64) };
const vault = { version: 1, keyVersion: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: 'A'.repeat(22) }, passphraseEnvelope: wrapped, recoveryEnvelope: wrapped };
const client: Client = { kind: 'browser', name: 'Browser', namespaces: ['settings', 'history'], products: ['portfolio', 'bank-subcaps'] };
const scriptClient: Client = { kind: 'userscript', name: 'Test script', namespaces: ['settings'], products: ['portfolio'] };
async function clerk(subject = 'user_a', secondsAgo = 0, fva: number[] | null = [0, -1], sts?: unknown) {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({ azp: ORIGIN, sid: 'sess_clerk', ...(fva ? { fva } : {}), ...(sts === undefined ? {} : { sts }), v: 2, nbf: seconds - secondsAgo - 5 }).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'test' }).setSubject(subject).setIssuer(env.CLERK_ISSUER).setAudience(env.CLERK_AUDIENCE).setIssuedAt(seconds - secondsAgo).setExpirationTime(seconds + 600).sign(privateKey);
}
async function request(path: string, method = 'GET', input?: unknown, token = browserAccess, headers: Record<string, string> = {}) {
  const h = new Headers({ ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(['GET', 'HEAD'].includes(method) ? {} : { Origin: ORIGIN, 'X-Finance-CSRF': '1' }), ...headers });
  if (input !== undefined) h.set('Content-Type', 'application/json');
  return mf.dispatchFetch(`${ORIGIN}/api/v1${path}`, { method, headers: h, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
}
async function own(account: string, c: Client) {
  const { session, token } = newSession(account, c);
  await insertSession(env, session, await hash(token)).run();
  return { session, token, access: await accessToken(env, session) };
}
async function put(id: string, revision = 0, namespace = 'settings', extra = {}, token = browserAccess) {
  return request(`/documents/${namespace}/${id}`, 'PUT', { expectedRevision: revision, mutationId: crypto.randomUUID(), product: 'portfolio', envelope: encrypted, ...extra }, token);
}
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true }); privateKey = pair.privateKey;
  const bindings = { APP_ORIGIN: ORIGIN, CLERK_ISSUER: 'https://test.clerk.accounts.dev', CLERK_AUDIENCE: 'finance-test', CLERK_JWT_KEY: await exportSPKI(pair.publicKey), CLERK_SECRET_KEY: 'sk_test_example', CLERK_PUBLISHABLE_KEY: 'pk_test_example', ACCESS_JWT_SECRET: random(), SESSION_WRAP_SECRET: random(), CLERK_WEBHOOK_SECRET: 'whsec_' + btoa('x'.repeat(32)) };
  const bundle = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['node:*'] });
  mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-10-04', compatibilityFlags: ['nodejs_compat'], unsafeTriggerHandlers: true, d1Databases: { DB: 'test' }, r2Buckets: { BLOBS: 'test' }, bindings, serviceBindings: { ASSETS: async () => new Response('asset') }, outboundService: async req => {
    if (new URL(req.url).hostname === 'api.clerk.com') return Response.json({ object: 'user', id: new URL(req.url).pathname.split('/').pop(), two_factor_enabled: mfaEnabled, banned: clerkBanned, updated_at: clerkUpdatedAt });
    throw new Error('Unexpected outbound request');
  } });
  env = { DB: await mf.getD1Database('DB'), BLOBS: await mf.getR2Bucket('BLOBS'), ...bindings } as unknown as Env;
  const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  // D1.exec splits on lines and cannot apply multiline trigger bodies. Pass
  // each complete statement through prepare instead, as Wrangler does.
  const [tables, ...triggers] = migration.replace(/--[^\n]*/g, '').split('CREATE TRIGGER');
  await env.DB.batch(tables.split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)));
  for (const trigger of triggers) await env.DB.prepare('CREATE TRIGGER' + trigger).run();
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  mfaEnabled = false;
  clerkBanned = false; clerkUpdatedAt = Date.now();
  await env.DB.batch(['commands', 'mutations', 'documents', 'refresh_history', 'pairings', 'sessions', 'blobs', 'accounts', 'rate_limits', 'webhooks', 'cleanup_state'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.prepare('UPDATE admission_limits SET max_pairings=1000,max_rates=10000 WHERE id=1').run();
  const page = await env.BLOBS.list(); if (page.objects.length) await env.BLOBS.delete(page.objects.map(o => o.key));
  await env.DB.prepare('INSERT INTO accounts(id,subject,created_at) VALUES(?,?,?)').bind('account_a', 'user_a', Date.now()).run();
  await env.DB.prepare('INSERT INTO accounts(id,subject,created_at) VALUES(?,?,?)').bind('account_b', 'user_b', Date.now()).run();
  const b = await own('account_a', client); browserSession = b.session; browserAccess = b.access;
  const s = await own('account_a', scriptClient); scriptSession = s.session; scriptAccess = s.access; scriptRefresh = s.token;
  expect((await request('/vault', 'PUT', { expectedRevision: 0, mutationId: crypto.randomUUID(), vault })).status).toBe(200);
});

describe('real D1/R2 API security', () => {
  it('verifies Clerk signatures/freshness and only exchanges browser sessions', async () => {
    const valid = await clerk();
    expect((await request('/session/exchange', 'POST', { clerkToken: valid, client }, '')).status).toBe(200);
    expect((await request('/session/exchange', 'POST', { clerkToken: await clerk('user_a', 301), client }, '')).status).toBe(401);
    expect((await request('/session/exchange', 'POST', { clerkToken: valid.slice(0, -10) + 'AAAAAAAAAA', client }, '')).status).toBe(401);
    expect((await request('/session/exchange', 'POST', { clerkToken: valid, client: scriptClient }, '')).status).toBe(403);
  });
  it('requires exact origin and CSRF for browser mutations, forbids script cookies and scope escalation', async () => {
    expect((await request('/vault', 'PUT', { expectedRevision: 1, mutationId: crypto.randomUUID(), vault }, browserAccess, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request('/session/logout-all', 'POST', {}, browserAccess, { 'X-Finance-CSRF': '' })).status).toBe(403);
    expect((await request('/me', 'GET', undefined, scriptAccess, { Cookie: 'other=1' })).status).toBe(403);
    expect((await request('/documents/history', 'GET', undefined, scriptAccess)).status).toBe(403);
    expect((await request('/vault', 'PUT', { expectedRevision: 1, mutationId: crypto.randomUUID(), vault }, scriptAccess)).status).toBe(403);
    expect((await request('/export', 'GET', undefined, scriptAccess)).status).toBe(403);
    expect((await request('/me', 'GET', undefined, await clerk())).status).toBe(401);
  });
  it('isolates tenants including signed pagination cursors', async () => {
    expect((await put('a')).status).toBe(200); expect((await put('b')).status).toBe(200);
    const other = await own('account_b', client);
    expect((await request('/documents/settings/a', 'GET', undefined, other.access)).status).toBe(404);
    const page = await (await request('/documents/settings?limit=1')).json();
    expect(page.documents).toHaveLength(1); expect(page.cursor).toBeTruthy();
    expect((await request(`/documents/settings?cursor=${page.cursor}`, 'GET', undefined, other.access)).status).toBe(400);
    expect((await request(`/documents/history?cursor=${page.cursor}`)).status).toBe(400);
    const next = await (await request(`/documents/settings?cursor=${page.cursor}`)).json(); expect(next.documents[0].id).toBe('b');
  });
  it('rotates refresh atomically and recovers identical request retries without false revocation', async () => {
    const id = crypto.randomUUID(), payload = { refreshToken: scriptRefresh }, h = { 'X-Finance-Refresh-Id': id };
    const results = await Promise.all(Array.from({ length: 8 }, () => request('/session/refresh', 'POST', payload, '', h)));
    expect(results.map(r => r.status)).toEqual(Array(8).fill(200));
    const values = await Promise.all(results.map(r => r.json()));
    expect(new Set(values.map(v => v.refreshToken)).size).toBe(1); expect(values[0].refreshToken).not.toBe(scriptRefresh);
    expect((await request('/session/refresh', 'POST', payload, '', { 'X-Finance-Refresh-Id': crypto.randomUUID() })).status).toBe(409);
    expect((await request('/me', 'GET', undefined, scriptAccess)).status).toBe(200);
    await env.DB.prepare('UPDATE refresh_history SET grace_until=0 WHERE session_id=?').bind(scriptSession.id).run();
    expect((await request('/session/refresh', 'POST', payload, '', h)).status).toBe(401);
    expect((await request('/me', 'GET', undefined, values[0].accessToken)).status).toBe(401);
  });
  it('does not let explicit JSON credentials bypass cookie CSRF', async () => {
    expect((await request('/session/refresh', 'POST', { refreshToken: scriptRefresh }, '', { Cookie: '__Host-finance-refresh=whatever', Origin: 'null', 'X-Finance-Refresh-Id': crypto.randomUUID() })).status).toBe(403);
    expect((await request('/session/refresh', 'POST', {}, '', { Cookie: '__Host-finance-refresh=' + scriptRefresh, Origin: 'null' })).status).toBe(403);
  });
  it('checks revocation, idle and absolute expiry on every access call', async () => {
    await env.DB.prepare('UPDATE sessions SET idle_expires=0 WHERE id=?').bind(scriptSession.id).run();
    expect((await request('/me', 'GET', undefined, scriptAccess)).status).toBe(401);
    await env.DB.prepare('UPDATE sessions SET absolute_expires=0 WHERE id=?').bind(browserSession.id).run();
    expect((await request('/me')).status).toBe(401);
  });
  it('pairs with inspection, approval and atomic proof redemption; response loss is recoverable', async () => {
    const created = await request('/pairing/create', 'POST', { client: scriptClient }, ''); expect(created.status).toBe(201);
    const p = await created.json();
    expect((await request('/pairing/inspect', 'POST', { pairingId: p.pairingId, code: p.code })).status).toBe(200);
    expect((await request('/pairing/redeem', 'POST', { pairingId: p.pairingId, secret: p.secret }, '')).status).toBe(409);
    expect((await request('/pairing/approve', 'POST', { pairingId: p.pairingId, code: p.code }, scriptAccess)).status).toBe(403);
    expect((await request('/pairing/approve', 'POST', { pairingId: p.pairingId, code: p.code })).status).toBe(204);
    const responses = await Promise.all(Array.from({ length: 6 }, () => request('/pairing/redeem', 'POST', { pairingId: p.pairingId, secret: p.secret }, '')));
    expect(responses.map(r => r.status)).toEqual(Array(6).fill(200));
    const values = await Promise.all(responses.map(r => r.json()));
    expect(new Set(values.map(v => v.sessionId)).size).toBe(1); expect(new Set(values.map(v => v.refreshToken)).size).toBe(1);
    expect((await request('/documents/history', 'GET', undefined, values[0].accessToken)).status).toBe(403);
    expect((await request('/pairing/redeem', 'POST', { pairingId: p.pairingId, secret: random() }, '')).status).toBe(410);
  });
  it('limits pairing create and code guesses', async () => {
    const created = await (await request('/pairing/create', 'POST', { client: scriptClient }, '')).json();
    for (let i = 0; i < 20; i++) expect((await request('/pairing/inspect', 'POST', { pairingId: created.pairingId, code: created.code })).status).toBe(200);
    expect((await request('/pairing/approve', 'POST', { pairingId: created.pairingId, code: created.code })).status).toBe(410);
    for (let i = 0; i < 9; i++) expect((await request('/pairing/create', 'POST', { client: scriptClient }, '')).status).toBe(201);
    expect((await request('/pairing/create', 'POST', { client: scriptClient }, '')).status).toBe(429);
  });
  it('enforces CAS, payload-bound idempotency and revision tombstones', async () => {
    const mutation = { expectedRevision: 0, mutationId: crypto.randomUUID(), product: 'portfolio', envelope: encrypted };
    const initial = await request('/documents/settings/a', 'PUT', mutation); expect(initial.status).toBe(200); const value = await initial.json();
    expect(await (await request('/documents/settings/a', 'PUT', mutation)).json()).toEqual(value);
    expect((await request('/documents/settings/a', 'PUT', { ...mutation, envelope: { ...encrypted, iv: 'BAAAAAAAAAAAAAAA' } })).status).toBe(409);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => put('a', 1)));
    expect(concurrent.filter(r => r.status === 200)).toHaveLength(1); expect(concurrent.filter(r => r.status === 409)).toHaveLength(7);
    const deletion = { expectedRevision: 2, mutationId: crypto.randomUUID() };
    expect((await request('/documents/settings/a', 'DELETE', deletion)).status).toBe(204);
    expect((await request('/documents/settings/a', 'DELETE', deletion)).status).toBe(204);
    expect((await put('a', 0)).status).toBe(409); expect((await put('a', 3)).status).toBe(200);
  });
  it('serializes concurrent quota reservations and document count commits', async () => {
    await env.DB.prepare('UPDATE accounts SET max_documents=1 WHERE id=?').bind('account_a').run();
    const responses = await Promise.all([put('a'), put('b'), put('c')]); expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(responses.filter(r => r.status === 413)).toHaveLength(2);
    await cleanup(env);
    const sum = await env.DB.prepare("SELECT SUM(bytes) AS bytes FROM blobs WHERE state='committed'").first<{ bytes: number }>();
    await env.DB.prepare('UPDATE accounts SET max_bytes=? WHERE id=?').bind(sum!.bytes, 'account_a').run();
    expect((await put('d')).status).toBe(413);
  });
  it('rejects structurally invalid ciphertext and unsafe key version changes', async () => {
    expect((await put('bad', 0, 'settings', { envelope: { ...encrypted, iv: 'AAAAAAAAAAAAAAAB' } })).status).toBe(200); // canonical 12-byte IV
    expect((await put('bad2', 0, 'settings', { envelope: { ...encrypted, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAB' } })).status).toBe(400);
    expect((await put('wrongkey', 0, 'settings', { envelope: { ...encrypted, keyVersion: 2 } })).status).toBe(409);
    expect((await request('/vault', 'PUT', { expectedRevision: 1, mutationId: crypto.randomUUID(), vault: { ...vault, keyVersion: 2, passphraseEnvelope: { ...wrapped, keyVersion: 2 }, recoveryEnvelope: { ...wrapped, keyVersion: 2 } } })).status).toBe(409);
  });
  it('uses calendar months, rejects expired history and physically removes all old versions', async () => {
    expect(historyCutoff(Date.parse('2026-05-31T12:34:56.000Z'))).toBe('2026-02-28T12:34:56.000Z');
    expect(historyCutoff(Date.parse('2024-05-31T12:34:56.000Z'))).toBe('2024-02-29T12:34:56.000Z');
    expect((await put('expired', 0, 'history', { occurredAt: '2020-01-01T00:00:00.000Z' })).status).toBe(410);
    expect((await put('history', 0, 'history', { occurredAt: new Date().toISOString() })).status).toBe(200);
    expect((await put('history', 1, 'history', { occurredAt: new Date().toISOString() })).status).toBe(200);
    expect((await put('settings')).status).toBe(200);
    await cleanup(env, Date.now() + 130 * 86400000);
    const objects = await env.BLOBS.list(); expect(objects.objects).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT blob_key FROM mutations WHERE namespace='history'").all(); expect(rows.results.every(r => r.blob_key === null)).toBe(true);
    const settings = await env.DB.prepare("SELECT blob_key FROM documents WHERE namespace='settings' AND id='settings'").first<{ blob_key: string }>();
    expect(settings?.blob_key).toBeTruthy();
  });
  it('makes deletion durable, retryable and non-resurrectable even with concurrent writes', async () => {
    const token = await clerk(), input = { clerkToken: token, confirmation: 'DELETE' };
    expect((await put('before')).status).toBe(200);
    const results = await Promise.all([request('/account', 'DELETE', input), put('racing')]); expect(results[0].status).toBe(204);
    expect((await request('/me')).status).toBe(401);
    expect((await request('/account', 'DELETE', input)).status).toBe(204);
    expect((await request('/session/exchange', 'POST', { clerkToken: token, client }, '')).status).toBe(403);
    await cleanup(env); await cleanup(env);
    expect((await env.BLOBS.list()).objects).toHaveLength(0);
    expect((await env.DB.prepare('SELECT * FROM documents').all()).results).toHaveLength(0);
    const account = await env.DB.prepare('SELECT deleted_at FROM accounts WHERE subject=?').bind('user_a').first<{ deleted_at: number }>(); expect(account?.deleted_at).toBeTruthy();
    expect((await request('/account', 'DELETE', input)).status).toBe(204);
  });
  it('bounds chunked and oversized JSON bodies without trusting content-length', async () => {
    const response = await mf.dispatchFetch(ORIGIN + '/api/v1/pairing/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: ' '.repeat(MAX_REQUEST_BODY_BYTES + 1) });
    expect(response.status).toBe(413);
    await response.arrayBuffer();
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunks++ === 4) controller.close(); else controller.enqueue(new Uint8Array(500000).fill(32));
    } });
    const chunked = await mf.dispatchFetch(ORIGIN + '/api/v1/pairing/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: stream, duplex: 'half' });
    expect(chunked.status).toBe(413);
    await chunked.arrayBuffer();
    const invalid = await request('/pairing/create', 'POST', { client: scriptClient, extra: true }, ''); expect(invalid.status).toBe(400);
  });
  it('streams encrypted exports and provides no-store, health and config', async () => {
    expect((await put('a')).status).toBe(200);
    const response = await request('/export'); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const result = await response.json(); expect(result.documents[0].envelope).toEqual(encrypted); expect(result.accountId).toBe('account_a');
    expect(await (await request('/health', 'GET', undefined, '')).json()).toEqual({ ok: true });
    expect((await request('/missing')).status).toBe(404);
  });
  it('accepts only signed, timely Svix lifecycle events with durable idempotent revocation', async () => {
    expect((await put('a')).status).toBe(200);
    const id = 'msg_test_1', date = new Date(), raw = JSON.stringify({ type: 'user.deleted', data: { id: 'user_a' } });
    const signature = new Webhook(env.CLERK_WEBHOOK_SECRET).sign(id, date, raw);
    const send = (sig = signature, timestamp = Math.floor(date.getTime() / 1000)) => mf.dispatchFetch(ORIGIN + '/api/v1/webhooks/clerk', { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': sig }, body: raw });
    expect((await send('v1,AAAA')).status).toBe(401);
    expect((await send(signature, 1)).status).toBe(401);
    expect((await send()).status).toBe(204); expect((await send()).status).toBe(204);
    expect((await request('/me')).status).toBe(401);
    expect((await env.DB.prepare('SELECT * FROM webhooks').all()).results).toHaveLength(1);
    await cleanup(env); expect((await env.BLOBS.list()).objects).toHaveLength(0);
    expect((await send()).status).toBe(204);
    expect((await env.DB.prepare("SELECT cleanup_pending FROM accounts WHERE subject='user_a'").first<{ cleanup_pending: number }>())!.cleanup_pending).toBe(0);
    expect((await request('/session/exchange', 'POST', { clerkToken: await clerk(), client }, '')).status).toBe(403);
  });
  it('keeps browser refresh tokens out of JSON and rotates secure cookies with retries', async () => {
    const exchange = await request('/session/exchange', 'POST', { clerkToken: await clerk(), client }, '');
    const initial = await exchange.json(); expect(initial.refreshToken).toBeUndefined();
    const setCookie = exchange.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('; Secure; HttpOnly; SameSite=Strict;'); expect(setCookie).not.toContain('Domain=');
    const cookie = setCookie.split(';')[0], headers = { Cookie: cookie, 'X-Finance-Refresh-Id': crypto.randomUUID() };
    const refresh = await request('/session/refresh', 'POST', {}, '', headers); expect(refresh.status).toBe(200);
    expect((await refresh.json()).refreshToken).toBeUndefined(); expect(refresh.headers.get('Set-Cookie')).not.toBe(setCookie);
    const retry = await request('/session/refresh', 'POST', {}, '', headers); expect(retry.status).toBe(200);
    expect(retry.headers.get('Set-Cookie')).toBe(refresh.headers.get('Set-Cookie'));
    expect((await request('/session/logout', 'POST', {}, '', { Cookie: refresh.headers.get('Set-Cookie')!.split(';')[0] })).status).toBe(204);
    expect((await request('/session/logout', 'POST', {}, '')).status).toBe(204);
  });
  it('handles different refresh IDs racing without revocation, then rejects stale successor retries', async () => {
    const first = crypto.randomUUID(), second = crypto.randomUUID(), input = { refreshToken: scriptRefresh };
    const responses = await Promise.all([request('/session/refresh', 'POST', input, '', { 'X-Finance-Refresh-Id': first }), request('/session/refresh', 'POST', input, '', { 'X-Finance-Refresh-Id': second })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const success = await responses.find(r => r.status === 200)!.json();
    expect((await request('/session/refresh', 'POST', { refreshToken: success.refreshToken }, '', { 'X-Finance-Refresh-Id': crypto.randomUUID() })).status).toBe(200);
    const winnerId = responses[0].status === 200 ? first : second;
    const retry = await request('/session/refresh', 'POST', input, '', { 'X-Finance-Refresh-Id': winnerId }); expect(retry.status).toBe(409);
    expect((await retry.json()).error.code).toBe('refresh_superseded');
    expect((await request('/me', 'GET', undefined, scriptAccess)).status).toBe(200);
  });
  it('replays simultaneous identical CAS mutations exactly once and preserves original responses', async () => {
    const input = { expectedRevision: 0, mutationId: crypto.randomUUID(), product: 'portfolio', envelope: encrypted };
    const responses = await Promise.all(Array.from({ length: 6 }, () => request('/documents/settings/a', 'PUT', input)));
    expect(responses.map(r => r.status)).toEqual(Array(6).fill(200));
    const values = await Promise.all(responses.map(r => r.json())); expect(new Set(values.map(v => JSON.stringify(v))).size).toBe(1);
    expect((await put('a', 1)).status).toBe(200);
    expect(await (await request('/documents/settings/a', 'PUT', input)).json()).toEqual(values[0]);
    await cleanup(env);
    expect((await env.BLOBS.list()).objects).toHaveLength(2);
  });
  it('serializes vault CAS and rejects unknown fields and wrapped-key version mismatches', async () => {
    const input = { expectedRevision: 1, mutationId: crypto.randomUUID(), vault };
    const responses = await Promise.all(Array.from({ length: 4 }, () => request('/vault', 'PUT', { ...input, mutationId: crypto.randomUUID() })));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1); expect(responses.filter(r => r.status === 409)).toHaveLength(3);
    expect((await request('/vault', 'PUT', { expectedRevision: 2, mutationId: crypto.randomUUID(), vault: { ...vault, recoveryEnvelope: { ...wrapped, keyVersion: 2 } } })).status).toBe(400);
    expect((await request('/vault', 'PUT', { ...input, accountId: 'account_b' })).status).toBe(400);
  });
  it('excludes expired history before cleanup and returns 410 for stale replay', async () => {
    const input = { expectedRevision: 0, mutationId: crypto.randomUUID(), product: 'portfolio', envelope: encrypted, occurredAt: new Date().toISOString() };
    expect((await request('/documents/history/a', 'PUT', input)).status).toBe(200);
    const old = '2020-01-01T00:00:00.000Z';
    await env.DB.batch([
      env.DB.prepare("UPDATE documents SET occurred_at=? WHERE namespace='history'").bind(old),
      env.DB.prepare("UPDATE mutations SET occurred_at=? WHERE namespace='history'").bind(old),
      env.DB.prepare('UPDATE blobs SET occurred_at=? WHERE occurred_at IS NOT NULL').bind(old),
    ]);
    expect((await request('/documents/history/a')).status).toBe(410);
    expect((await (await request('/documents/history')).json()).documents).toEqual([]);
    expect((await (await request('/export')).json()).documents).toEqual([]);
    expect((await request('/documents/history/a', 'PUT', input)).status).toBe(410);
    await cleanup(env); expect((await env.BLOBS.list()).objects).toHaveLength(0);
  });
  it('rejects account deletion with mismatched Clerk subject and drains more than 100 tombstones fairly', async () => {
    expect((await request('/account', 'DELETE', { clerkToken: await clerk('user_b'), confirmation: 'DELETE' })).status).toBe(403);
    const statements = [];
    for (let i = 0; i < 105; i++) {
      statements.push(env.DB.prepare('INSERT INTO accounts(id,subject,created_at,deleted_at,cleanup_pending) VALUES(?,?,1,1,1)').bind(`dead_${i}`, `deleted_user_${i}`));
      statements.push(env.DB.prepare("INSERT INTO documents(account_id,namespace,product,id,revision,updated_at) VALUES(?,'settings','portfolio','tombstone',1,'2026-01-01T00:00:00.000Z')").bind(`dead_${i}`));
    }
    for (let i = 0; i < statements.length; i += 80) await env.DB.batch(statements.slice(i, i + 80));
    for (let i = 0; i < 11; i++) await cleanup(env);
    expect((await env.DB.prepare("SELECT * FROM documents WHERE account_id LIKE 'dead_%'").all()).results).toHaveLength(0);
  }, 30000);
  it('exports beyond one metadata page without duplication or omission', async () => {
    expect((await put('base')).status).toBe(200);
    const row = await env.DB.prepare("SELECT blob_key FROM documents WHERE id='base'").first<{ blob_key: string }>();
    const statements = Array.from({ length: 103 }, (_, i) => env.DB.prepare("INSERT INTO documents(account_id,namespace,product,id,revision,blob_key,updated_at) VALUES('account_a','settings','portfolio',?,1,?,?)").bind('z' + String(i).padStart(3, '0'), row!.blob_key, new Date().toISOString()));
    await env.DB.batch(statements.slice(0, 80)); await env.DB.batch(statements.slice(80));
    const exported = await (await request('/export')).json();
    expect(exported.documents).toHaveLength(104); expect(new Set(exported.documents.map((d: { id: string }) => d.id)).size).toBe(104);
    expect(exported.documents[103].id).toBe('z102');
  });
  it('executes the actual scheduled worker and bulk-cleans expired pending uploads beyond 100 parameters', async () => {
    const keys = Array.from({ length: 120 }, (_, i) => `account_a/abandoned_${i}`);
    const statements = keys.map(k => env.DB.prepare("INSERT INTO blobs(key,account_id,bytes,state,expires,created_at) VALUES(?,'account_a',100,'pending',0,0)").bind(k));
    await env.DB.batch(statements.slice(0, 80)); await env.DB.batch(statements.slice(80));
    for (let offset = 0; offset < keys.length; offset += 20) await Promise.all(keys.slice(offset, offset + 20).map(k => env.BLOBS.put(k, 'encrypted')));
    const response = await mf.dispatchFetch(ORIGIN + '/cdn-cgi/handler/scheduled'); expect(response.status).toBe(200);
    expect((await env.BLOBS.list()).objects).toHaveLength(0);
    expect((await env.DB.prepare('SELECT * FROM blobs').all()).results).toHaveLength(0);
  });
  it('caps permanent delete receipts and vault responses atomically while preserving replay at the cap', async () => {
    expect((await put('a')).status).toBe(200);
    const used = await env.DB.prepare("SELECT metadata_bytes FROM accounts WHERE id='account_a'").first<{ metadata_bytes: number }>();
    await env.DB.prepare("UPDATE accounts SET metadata_limit=? WHERE id='account_a'").bind(used!.metadata_bytes + 512).run();
    const deletion = { expectedRevision: 1, mutationId: crypto.randomUUID() };
    const responses = await Promise.all([request('/documents/settings/a', 'DELETE', deletion), request('/documents/settings/a', 'DELETE', { ...deletion, mutationId: crypto.randomUUID() })]);
    expect(responses.filter(r => r.status === 204)).toHaveLength(1); expect(responses.filter(r => r.status === 413)).toHaveLength(1);
    const winner = await env.DB.prepare("SELECT id FROM mutations WHERE document_id='a' AND status=204").first<{ id: string }>();
    expect((await request('/documents/settings/a', 'DELETE', { ...deletion, mutationId: winner!.id })).status).toBe(204);
    expect((await request('/documents/settings/a', 'DELETE', { expectedRevision: 2, mutationId: crypto.randomUUID() })).status).toBe(413);
    const vaultMutation = { expectedRevision: 1, mutationId: crypto.randomUUID(), vault };
    expect((await request('/vault', 'PUT', vaultMutation)).status).toBe(413);
    const after = await env.DB.prepare("SELECT metadata_bytes,metadata_limit,receipt_count FROM accounts WHERE id='account_a'").first<{ metadata_bytes: number; metadata_limit: number; receipt_count: number }>();
    expect(after!.metadata_bytes).toBe(after!.metadata_limit); expect(after!.receipt_count).toBe(3);
    const first = await env.DB.prepare("SELECT id FROM mutations WHERE namespace='vault'").first<{ id: string }>();
    expect((await request('/vault', 'PUT', { expectedRevision: 0, mutationId: first!.id, vault })).status).toBe(200);
  });
  it('counts vault receipt UTF-8 bytes and enforces the independent receipt count', async () => {
    const before = await env.DB.prepare("SELECT metadata_bytes,receipt_count FROM accounts WHERE id='account_a'").first<{ metadata_bytes: number; receipt_count: number }>();
    const input = { expectedRevision: 1, mutationId: crypto.randomUUID(), vault };
    expect((await request('/vault', 'PUT', input)).status).toBe(200);
    const row = await env.DB.prepare('SELECT metadata_size,response FROM mutations WHERE id=?').bind(input.mutationId).first<{ metadata_size: number; response: string }>();
    expect(row!.metadata_size).toBe(512 + new TextEncoder().encode(row!.response).length);
    const after = await env.DB.prepare("SELECT metadata_bytes,receipt_count FROM accounts WHERE id='account_a'").first<{ metadata_bytes: number; receipt_count: number }>();
    expect(after!.metadata_bytes - before!.metadata_bytes).toBe(row!.metadata_size);
    await env.DB.prepare("UPDATE accounts SET receipt_limit=receipt_count WHERE id='account_a'").run();
    expect((await request('/vault', 'PUT', { ...input, expectedRevision: 2, mutationId: crypto.randomUUID() })).status).toBe(413);
    expect((await request('/vault', 'PUT', input)).status).toBe(200);
  });
  it('bounds list ciphertext to two MiB and returns a cursor without skipping large documents', async () => {
    const large = { ...encrypted, ciphertext: 'A'.repeat(960000) };
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect((await put(id, 0, 'settings', { envelope: large })).status).toBe(200);
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const response = await request(`/documents/settings?limit=100${cursor ? '&cursor=' + cursor : ''}`);
      const text = await response.text(); expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(2 * 1048576);
      const page = JSON.parse(text); expect(page.documents.length).toBeLessThanOrEqual(2);
      ids.push(...page.documents.map((d: { id: string }) => d.id)); cursor = page.cursor;
    } while (cursor);
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('requires signed factor verification freshness and fresh enrolled MFA, not a refreshed iat', async () => {
    for (const fva of [null, [-1, -1], [6, -1], [0], [0.1, -1]]) {
      expect((await request('/account', 'DELETE', { clerkToken: await clerk('user_a', 0, fva), confirmation: 'DELETE' })).status).toBe(403);
    }
    // A cached JWT issued four minutes ago cannot extend a four-minute fva.
    expect((await request('/account', 'DELETE', { clerkToken: await clerk('user_a', 240, [4, -1]), confirmation: 'DELETE' })).status).toBe(403);
    mfaEnabled = true;
    for (const fva of [[0, -1], [0, 6]]) expect((await request('/account', 'DELETE', { clerkToken: await clerk('user_a', 0, fva), confirmation: 'DELETE' })).status).toBe(403);
    expect((await request('/account', 'DELETE', { clerkToken: await clerk('user_a', 0, [0, 0]), confirmation: 'DELETE' })).status).toBe(204);
  });
  it('revokes with refresh proof despite an expired/stale bearer and rejects unrelated unprovisioned deletion', async () => {
    expect((await request('/session/logout', 'POST', { refreshToken: scriptRefresh }, 'expired.invalid.bearer')).status).toBe(204);
    expect((await request('/me', 'GET', undefined, scriptAccess)).status).toBe(401);
    expect((await request('/account', 'DELETE', { clerkToken: await clerk('user_missing'), confirmation: 'DELETE' })).status).toBe(403);
    expect(await env.DB.prepare("SELECT id FROM accounts WHERE subject='user_missing'").first()).toBeNull();
  });
  it('enforces immutable products on reads, writes, tombstones, replay, list filters and cursors', async () => {
    const bank = await own('account_a', { ...scriptClient, products: ['bank-subcaps'] });
    const input = { expectedRevision: 0, mutationId: crypto.randomUUID(), product: 'portfolio', envelope: encrypted };
    expect((await request('/documents/settings/a', 'PUT', input)).status).toBe(200);
    expect((await put('b', 0, 'settings', { product: 'bank-subcaps' }, bank.access)).status).toBe(200);
    expect((await request('/documents/settings/a', 'GET', undefined, bank.access)).status).toBe(403);
    expect((await request('/documents/settings/a', 'PUT', input, bank.access)).status).toBe(403);
    expect((await request('/documents/settings/a', 'DELETE', { expectedRevision: 1, mutationId: crypto.randomUUID() }, bank.access)).status).toBe(403);
    expect((await request('/documents/settings/b', 'GET', undefined, scriptAccess)).status).toBe(403);
    expect((await put('a', 1, 'settings', { product: 'bank-subcaps' })).status).toBe(409);
    const page = await (await request('/documents/settings', 'GET', undefined, bank.access)).json();
    expect(page.documents.map((d: { id: string }) => d.id)).toEqual(['b']);
    expect((await request('/documents/settings?product=portfolio', 'GET', undefined, bank.access)).status).toBe(403);
    expect((await request('/documents/settings/a', 'DELETE', { expectedRevision: 1, mutationId: crypto.randomUUID() })).status).toBe(204);
    expect((await put('a', 2, 'settings', { product: 'bank-subcaps' })).status).toBe(409);
    expect((await request('/documents/settings/a', 'PUT', input)).status).toBe(200);
    expect((await put('c')).status).toBe(200); expect((await put('d')).status).toBe(200);
    const cursor = (await (await request('/documents/settings?product=portfolio&limit=1')).json()).cursor;
    expect((await request('/documents/settings?product=bank-subcaps&cursor=' + cursor)).status).toBe(400);
    expect((await request('/pairing/create', 'POST', { client: { ...scriptClient, products: ['portfolio', 'bank-subcaps'] } }, '')).status).toBe(400);
    expect((await request('/session/exchange', 'POST', { clerkToken: await clerk(), client: { ...client, products: ['portfolio'] } }, '')).status).toBe(400);
  });
  it('progresses large expiry/deletion backlogs in bounded indexed batches', async () => {
    await env.DB.prepare('UPDATE admission_limits SET max_pairings=2000 WHERE id=1').run();
    expect((await put('seed', 0, 'history', { occurredAt: new Date().toISOString() })).status).toBe(200);
    const blob = await env.DB.prepare("SELECT blob_key FROM documents WHERE id='seed'").first<{ blob_key: string }>();
    // Seed a realistic backlog with SQLite itself rather than allocating
    // thousands of RPC proxy prepared-statement handles in the test process.
    const seq = "WITH RECURSIVE seq(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<1204) ";
    const small = "WITH RECURSIVE seq(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<149) ";
    const id = "'backlog_'||printf('%04d',i)";
    await env.DB.batch([
      env.DB.prepare(seq + `INSERT INTO rate_limits(key,count,expires) SELECT ${id},1,0 FROM seq`),
      env.DB.prepare(seq + `INSERT INTO pairings(id,client,code_hash,secret_hash,expires) SELECT ${id},'{}','hash','hash',0 FROM seq`),
      env.DB.prepare(seq + `INSERT INTO webhooks(id,accepted_at) SELECT ${id},0 FROM seq`),
      env.DB.prepare(seq + `INSERT INTO documents(account_id,namespace,product,id,revision,blob_key,occurred_at,updated_at) SELECT 'account_a','history','portfolio',${id},1,?,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z' FROM seq`).bind(blob!.blob_key),
      env.DB.prepare(seq + `INSERT INTO mutations(account_id,namespace,product,document_id,id,hash,status,response,blob_key,occurred_at,created_at,metadata_size) SELECT 'account_a','history','portfolio',${id},${id},'hash',200,'{}',?,'2020-01-01T00:00:00.000Z',0,514 FROM seq`).bind(blob!.blob_key),
      env.DB.prepare(seq + `INSERT INTO documents(account_id,namespace,product,id,revision,updated_at) SELECT 'account_b','settings','portfolio',${id},1,'2020-01-01T00:00:00.000Z' FROM seq`),
      env.DB.prepare(small + `INSERT INTO sessions(id,account_id,client,created_at,last_used_at,idle_expires,absolute_expires,refresh_hash) SELECT 'expired_'||i,'account_a',?,0,0,0,0,'hash_'||i FROM seq`).bind(JSON.stringify(scriptClient)),
      env.DB.prepare(small + `INSERT INTO refresh_history(hash,session_id,request_id,successor,grace_until) SELECT 'old_'||i,'expired_'||i,'request','encrypted',0 FROM seq`),
    ]);
    await env.DB.prepare("UPDATE accounts SET deleted_at=1,cleanup_pending=1 WHERE id='account_b'").run();
    const queries = [
      ["SELECT rowid FROM documents WHERE namespace='history' AND blob_key IS NOT NULL AND occurred_at<'2021' ORDER BY occurred_at LIMIT 1000", 'documents_history'],
      ["SELECT rowid FROM mutations WHERE namespace='history' AND (blob_key IS NOT NULL OR response IS NOT NULL) AND occurred_at<'2021' ORDER BY occurred_at LIMIT 1000", 'mutations_history'],
      ["SELECT key FROM blobs WHERE state='pending' AND expires<=0 ORDER BY expires LIMIT 1000", 'blobs_state_expiry'],
      ["SELECT id FROM accounts WHERE deleted_at IS NOT NULL AND cleanup_pending=1 ORDER BY deleted_at,id LIMIT 10", 'accounts_cleanup'],
    ];
    for (const [sql, index] of queries) {
      const plan = await env.DB.prepare('EXPLAIN QUERY PLAN ' + sql).all<{ detail: string }>();
      expect(plan.results.map(r => r.detail).join(' ')).toContain(index);
    }
    await cleanup(env);
    const count = async (sql: string) => (await env.DB.prepare(sql).first<{ count: number }>())!.count;
    expect(await count("SELECT COUNT(*) AS count FROM rate_limits WHERE expires=0")).toBe(205);
    expect(await count("SELECT COUNT(*) AS count FROM pairings WHERE expires=0")).toBe(205);
    expect(await count("SELECT COUNT(*) AS count FROM webhooks WHERE accepted_at=0")).toBe(205);
    expect(await count("SELECT COUNT(*) AS count FROM documents WHERE namespace='history' AND occurred_at LIKE '2020%' AND blob_key IS NOT NULL")).toBe(205);
    expect(await count("SELECT COUNT(*) AS count FROM mutations WHERE namespace='history' AND occurred_at LIKE '2020%' AND response IS NOT NULL")).toBe(205);
    expect(await count("SELECT COUNT(*) AS count FROM documents WHERE account_id='account_b'")).toBe(205);
    expect(await count("SELECT COUNT(*) AS count FROM sessions WHERE idle_expires=0")).toBe(50);
    await cleanup(env); await cleanup(env);
    expect(await count("SELECT COUNT(*) AS count FROM rate_limits WHERE expires=0")).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM sessions WHERE idle_expires=0")).toBe(0);
    expect(await count("SELECT COUNT(*) AS count FROM documents WHERE account_id='account_b'")).toBe(0);
    expect((await env.DB.prepare("SELECT cleanup_pending FROM accounts WHERE id='account_b'").first<{ cleanup_pending: number }>())!.cleanup_pending).toBe(0);
  }, 60000);
  it('rejects pending and unknown signed Clerk statuses for exchange and deletion', async () => {
    for (const status of ['pending', 'ended', 'revoked', 'unexpected', null, false]) {
      const token = await clerk('user_a', 0, [0, -1], status);
      expect((await request('/session/exchange', 'POST', { clerkToken: token, client }, '')).status).toBe(401);
      expect((await request('/account', 'DELETE', { clerkToken: token, confirmation: 'DELETE' })).status).toBe(401);
    }
    expect((await request('/session/exchange', 'POST', { clerkToken: await clerk('user_a', 0, [0, -1], 'active'), client }, '')).status).toBe(200);
  });
  it('checks trusted user eligibility on cached exchange and step-up before a ban webhook arrives', async () => {
    const cached = await clerk(); clerkBanned = true; clerkUpdatedAt += 10;
    expect((await request('/session/exchange', 'POST', { clerkToken: cached, client }, '')).status).toBe(403);
    expect((await request('/account', 'DELETE', { clerkToken: cached, confirmation: 'DELETE' })).status).toBe(403);
    expect((await request('/me')).status).toBe(401);
    const account = await env.DB.prepare("SELECT disabled_at,deleted_at,vault FROM accounts WHERE id='account_a'").first<{ disabled_at: number; deleted_at: number | null; vault: string }>();
    expect(account!.disabled_at).toBeTruthy(); expect(account!.deleted_at).toBeNull(); expect(account!.vault).toBeTruthy();
  });
  it('applies monotonic signed ban/unban state without reviving old sessions or approved pairings', async () => {
    const p = await (await request('/pairing/create', 'POST', { client: scriptClient }, '')).json();
    expect((await request('/pairing/approve', 'POST', { pairingId: p.pairingId, code: p.code })).status).toBe(204);
    const candidate = newSession('account_a', client);
    const time = clerkUpdatedAt + 10;
    const event = async (id: string, banned: boolean, timestamp: number) => {
      const date = new Date(), raw = JSON.stringify({ type: 'user.updated', timestamp, data: { id: 'user_a', banned } });
      return mf.dispatchFetch(ORIGIN + '/api/v1/webhooks/clerk', { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': String(Math.floor(date.getTime() / 1000)), 'svix-signature': new Webhook(env.CLERK_WEBHOOK_SECRET).sign(id, date, raw) }, body: raw });
    };
    const concurrent = await Promise.all([put('racing'), event('ban_1', true, time)]);
    expect(concurrent[1].status).toBe(204); expect([200, 401, 413]).toContain(concurrent[0].status);
    expect((await request('/me')).status).toBe(401);
    expect((await request('/session/refresh', 'POST', { refreshToken: scriptRefresh }, '', { 'X-Finance-Refresh-Id': crypto.randomUUID() })).status).toBe(401);
    expect((await request('/pairing/redeem', 'POST', { pairingId: p.pairingId, secret: p.secret }, '')).status).toBe(410);
    expect((await event('unban_2', false, time + 20)).status).toBe(204);
    expect((await event('late_ban', true, time)).status).toBe(204);
    const state = await env.DB.prepare("SELECT disabled_at,deleted_at,session_epoch FROM accounts WHERE id='account_a'").first<{ disabled_at: number | null; deleted_at: number | null; session_epoch: number }>();
    expect(state!.disabled_at).toBeNull(); expect(state!.deleted_at).toBeNull(); expect(state!.session_epoch).toBe(1);
    expect((await request('/me')).status).toBe(401);
    expect((await request('/pairing/redeem', 'POST', { pairingId: p.pairingId, secret: p.secret }, '')).status).toBe(410);
    expect((await insertSession(env, candidate.session, await hash(candidate.token)).run()).meta.changes).toBe(0);
    await expect(env.DB.prepare(`INSERT INTO commands(id,account_id,session_id,namespace,product,document_id,mutation_id,hash,expected,now,updated_at,cutoff)
      VALUES(?,'account_a',?,'settings','portfolio','after_ban',?,'hash',0,?,?,?)`).bind(random(), browserSession.id, crypto.randomUUID(), Date.now(), new Date().toISOString(), historyCutoff()).run()).rejects.toThrow('inactive');
    clerkBanned = false; clerkUpdatedAt = time + 20;
    const exchanged = await request('/session/exchange', 'POST', { clerkToken: await clerk(), client }, ''); expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json(); expect((await request('/me', 'GET', undefined, tokens.accessToken)).status).toBe(200);
    await cleanup(env);
    expect((await env.DB.prepare('SELECT revoked_at FROM sessions WHERE id=?').bind(browserSession.id).first<{ revoked_at: number }>())!.revoked_at).toBeTruthy();
    expect((await request('/me', 'GET', undefined, tokens.accessToken)).status).toBe(200);
  });
  it('bounds anonymous pairing admission atomically and frees only expired records', async () => {
    const seq = "WITH RECURSIVE seq(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<998) ";
    await env.DB.prepare(seq + "INSERT INTO pairings(id,client,code_hash,secret_hash,expires) SELECT 'capacity_'||i,'{}','hash','hash',? FROM seq").bind(Date.now() + 600000).run();
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/pairing/create', 'POST', { client: scriptClient }, '', { 'CF-Connecting-IP': 'capacity_' + i })));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1); expect(responses.filter(r => r.status === 429)).toHaveLength(7);
    expect((await env.DB.prepare('SELECT pairing_count FROM admission_limits').first<{ pairing_count: number }>())!.pairing_count).toBe(1000);
    await env.DB.prepare("UPDATE pairings SET expires=0 WHERE id='capacity_0'").run();
    expect((await request('/pairing/create', 'POST', { client: scriptClient }, '', { 'CF-Connecting-IP': 'fresh_capacity' })).status).toBe(201);
    expect((await env.DB.prepare('SELECT pairing_count FROM admission_limits').first<{ pairing_count: number }>())!.pairing_count).toBe(1000);
  });
  it('caps unique-IP rate admissions without discarding existing live limiter history', async () => {
    const used = (await env.DB.prepare('SELECT rate_count FROM admission_limits').first<{ rate_count: number }>())!.rate_count;
    await env.DB.prepare('UPDATE admission_limits SET max_rates=?').bind(used + 1).run();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => request('/pairing/create', 'POST', { client: scriptClient }, '', { 'CF-Connecting-IP': 'rate_' + i })));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1); expect(responses.filter(r => r.status === 429)).toHaveLength(5);
    const winner = responses.findIndex(r => r.status === 201);
    for (let i = 0; i < 9; i++) expect((await request('/pairing/create', 'POST', { client: scriptClient }, '', { 'CF-Connecting-IP': 'rate_' + winner })).status).toBe(201);
    expect((await request('/pairing/create', 'POST', { client: scriptClient }, '', { 'CF-Connecting-IP': 'rate_' + winner })).status).toBe(429);
    expect((await env.DB.prepare('SELECT MAX(count) AS count FROM rate_limits').first<{ count: number }>())!.count).toBe(11);
    await env.DB.prepare('UPDATE rate_limits SET expires=0').run();
    expect((await request('/pairing/create', 'POST', { client: scriptClient }, '', { 'CF-Connecting-IP': 'new_rate' })).status).toBe(201);
  });
  it('accepts exactly one MiB decoded ciphertext within the shared body limit and rejects one byte over', async () => {
    const exact = { ...encrypted, ciphertext: encodeBase64url(new Uint8Array(MAX_DOCUMENT_BYTES)) };
    expect((await put('max_bytes', 0, 'settings', { envelope: exact })).status).toBe(200);
    const read = await (await request('/documents/settings/max_bytes')).json(); expect(read.envelope.ciphertext).toBe(exact.ciphertext);
    const over = { ...encrypted, ciphertext: encodeBase64url(new Uint8Array(MAX_DOCUMENT_BYTES + 1)) };
    expect((await put('one_byte_over', 0, 'settings', { envelope: over })).status).toBe(413);
    expect(await env.DB.prepare("SELECT id FROM documents WHERE id='one_byte_over'").first()).toBeNull();
  });
});
