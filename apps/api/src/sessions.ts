import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { clientSchema, exchangeRequestSchema, refreshRequestSchema, pairingCreateRequestSchema, pairingApproveRequestSchema, pairingRedeemRequestSchema, idSchema, DEFAULT_ENTITLEMENTS } from '@finance-tools/contracts';
import { accessToken, authenticate, body, browser, clerkSubject, csrf, fail, hash, iso, now, random, rate, seal, unseal } from './security';
import type { Bindings, Client, Ctx, Session } from './security';

export const sessions = new Hono<Bindings>();
const DAY = 86400000;
const COOKIE = '__Host-finance-refresh';
export function cookie(c: Ctx, token?: string) {
  c.header('Set-Cookie', `${COOKIE}=${token ?? ''}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token ? 90 * 86400 : 0}`);
}
function refreshCookie(c: Ctx): string | undefined {
  const matches = (c.req.header('Cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  if (matches.length > 1) fail(400, 'ambiguous_cookie');
  return matches[0]?.slice(COOKIE.length + 1);
}
export function newSession(account: string, client: Client): { session: Session; token: string } {
  const time = now();
  return { token: random(), session: { id: random(24), account_id: account, account_epoch: 0, client: JSON.stringify(client), created_at: time, last_used_at: time, idle_expires: time + 90 * DAY, absolute_expires: time + 365 * DAY, revoked_at: null, refresh_hash: '' } };
}
export function insertSession(env: Env, session: Session, tokenHash: string, condition = '1', args: (string | number)[] = []) {
  const epoch = session.account_epoch ?? 0;
  return env.DB.prepare(`INSERT INTO sessions(id,account_id,client,created_at,last_used_at,idle_expires,absolute_expires,refresh_hash,account_epoch)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL AND session_epoch=?)
    AND (SELECT COUNT(*) FROM sessions WHERE account_id=? AND account_epoch=? AND revoked_at IS NULL AND idle_expires>? AND absolute_expires>?)<100 AND ${condition}`)
    .bind(session.id, session.account_id, session.client, session.created_at, session.last_used_at, session.idle_expires, session.absolute_expires, tokenHash, epoch, session.account_id, epoch, session.account_id, epoch, now(), now(), ...args);
}
export async function tokens(c: Ctx, session: Session, token: string) {
  const script = (JSON.parse(session.client) as Client).kind === 'userscript';
  if (!script) cookie(c, token);
  return c.json({ accessToken: await accessToken(c.env, session), expiresIn: 900 as const, sessionId: session.id, ...(script ? { refreshToken: token } : {}) });
}
async function credential(c: Ctx, allowMissing = false, parsed?: z.infer<typeof refreshRequestSchema>) {
  const input = parsed ?? await body(c, refreshRequestSchema);
  const stored = refreshCookie(c);
  if (input.refreshToken) {
    if (c.req.header('Cookie')) fail(403, 'script_cookies_forbidden');
    return { token: input.refreshToken, kind: 'userscript' as const };
  }
  csrf(c);
  if (!stored && allowMissing) return { token: '', kind: 'browser' as const };
  if (!stored || !/^[A-Za-z0-9_-]{43}$/.test(stored)) fail(401, 'unauthorized');
  return { token: stored, kind: 'browser' as const };
}
function active(s: Session | null): s is Session {
  return !!s && s.revoked_at === null && s.idle_expires > now() && s.absolute_expires > now();
}
async function lookup(c: Ctx, tokenHash: string) {
  return c.env.DB.prepare(`SELECT s.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE a.deleted_at IS NULL AND a.disabled_at IS NULL AND s.account_epoch=a.session_epoch AND (s.refresh_hash=? OR s.id=(SELECT session_id FROM refresh_history WHERE hash=?))`).bind(tokenHash, tokenHash).first<Session>();
}
sessions.post('/session/exchange', async c => {
  csrf(c); await rate(c, 'exchange', 30);
  const input = await body(c, exchangeRequestSchema);
  if (input.client.kind !== 'browser') fail(403, 'pairing_required');
  if (new Set(input.client.products).size !== 2) fail(400, 'browser_products_required');
  const subject = await clerkSubject(c, input.clerkToken);
  const account = await c.env.DB.prepare('SELECT id,deleted_at,disabled_at,session_epoch FROM accounts WHERE subject=?').bind(subject).first<{ id: string; deleted_at: number | null; disabled_at: number | null; session_epoch: number }>();
  if (!account || account.deleted_at !== null) fail(403, 'account_deleted');
  if (account.disabled_at !== null) fail(403, 'account_disabled');
  const { session, token } = newSession(account.id, input.client);
  session.account_epoch = account.session_epoch;
  const result = await insertSession(c.env, session, await hash(token)).run();
  if (!result.meta.changes) {
    const activeAccount = await c.env.DB.prepare('SELECT id FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL AND session_epoch=?').bind(account.id, session.account_epoch).first();
    if (activeAccount) fail(429, 'session_limit');
    fail(403, 'account_unavailable');
  }
  return tokens(c, session, token);
});
sessions.post('/session/refresh', async c => {
  const { token, kind } = await credential(c);
  await rate(c, 'refresh', 120);
  const requestId = c.req.header('X-Finance-Refresh-Id');
  if (!requestId || !z.string().uuid().safeParse(requestId).success) fail(400, 'refresh_id_required');
  const oldHash = await hash(token), session = await lookup(c, oldHash);
  if (!active(session) || (JSON.parse(session.client) as Client).kind !== kind) fail(401, 'unauthorized');
  if (!clientSchema.safeParse(JSON.parse(session.client)).success) fail(401, 'client_upgrade_required');
  const successor = random(), successorHash = await hash(successor), time = now();
  const encrypted = await seal(c.env, successor, `refresh:${oldHash}`);
  // Both statements are one transaction. Only the transaction that inserted
  // this exact ciphertext may advance the current hash.
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO refresh_history(hash,session_id,request_id,successor,grace_until)
      SELECT ?,id,?,?,? FROM sessions WHERE id=? AND refresh_hash=? AND revoked_at IS NULL AND idle_expires>? AND absolute_expires>?
       AND EXISTS(SELECT 1 FROM accounts WHERE id=sessions.account_id AND deleted_at IS NULL AND disabled_at IS NULL AND session_epoch=sessions.account_epoch)`)
      .bind(oldHash, requestId, encrypted, time + 120000, session.id, oldHash, time, time),
    c.env.DB.prepare(`UPDATE sessions SET refresh_hash=?,last_used_at=?,idle_expires=MIN(?,absolute_expires)
      WHERE id=? AND refresh_hash=? AND EXISTS(SELECT 1 FROM refresh_history WHERE hash=? AND successor=?)`)
      .bind(successorHash, time, time + 90 * DAY, session.id, oldHash, oldHash, encrypted),
  ]);
  const previous = await c.env.DB.prepare('SELECT request_id,successor,grace_until FROM refresh_history WHERE hash=?').bind(oldHash).first<{ request_id: string; successor: string | null; grace_until: number }>();
  const current = await lookup(c, oldHash);
  if (!active(current)) fail(401, 'unauthorized');
  if (previous && previous.grace_until > now()) {
    if (previous.request_id !== requestId || !previous.successor) fail(409, 'refresh_in_progress');
    const recovered = await unseal(c.env, previous.successor, `refresh:${oldHash}`);
    if (current.refresh_hash !== await hash(recovered)) fail(409, 'refresh_superseded');
    return tokens(c, current, recovered);
  }
  await c.env.DB.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now(), session.id).run();
  cookie(c); return fail(401, 'refresh_reuse');
});
sessions.post('/session/logout', async c => {
  const input = await body(c, refreshRequestSchema);
  let session: Session | null = null;
  // Refresh proof remains sufficient even when an in-memory access JWT has
  // expired. Never let a stale bearer prevent credential-family revocation.
  if (input.refreshToken || refreshCookie(c) || !c.req.header('Authorization')) {
    const { token, kind } = await credential(c, true, input); session = await lookup(c, await hash(token));
    if (session && (JSON.parse(session.client) as Client).kind !== kind) fail(403, 'credential_kind');
  } else session = await authenticate(c);
  if (session) await c.env.DB.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now(), session.id).run();
  cookie(c); return c.body(null, 204);
});
sessions.post('/session/logout-all', async c => {
  const s = await authenticate(c); browser(c); await body(c, z.object({}).strict());
  await c.env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE account_id=? AND account_epoch=? AND revoked_at IS NULL AND idle_expires>? AND absolute_expires>?').bind(now(), s.account_id, s.account_epoch ?? 0, now(), now()).run();
  cookie(c); return c.body(null, 204);
});
sessions.get('/me', async c => {
  const s = await authenticate(c);
  const client = JSON.parse(s.client) as Client;
  return c.json({ accountId: s.account_id, entitlements: DEFAULT_ENTITLEMENTS, namespaces: client.namespaces, products: client.products });
});
sessions.get('/sessions', async c => {
  const s = await authenticate(c); browser(c);
  const rows = await c.env.DB.prepare('SELECT * FROM sessions WHERE account_id=? AND account_epoch=? AND revoked_at IS NULL AND idle_expires>? AND absolute_expires>? ORDER BY created_at DESC LIMIT 100').bind(s.account_id, s.account_epoch ?? 0, now(), now()).all<Session>();
  return c.json({ sessions: rows.results.map(row => ({ id: row.id, client: JSON.parse(row.client), createdAt: iso(row.created_at), lastUsedAt: iso(row.last_used_at), absoluteExpiresAt: iso(row.absolute_expires), current: row.id === s.id })) });
});
sessions.delete('/sessions/:id', async c => {
  const s = await authenticate(c); browser(c);
  const id = idSchema.safeParse(c.req.param('id')); if (!id.success) fail(400, 'invalid_id');
  await c.env.DB.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND account_id=?').bind(now(), id.data, s.account_id).run();
  if (id.data === s.id) cookie(c); return c.body(null, 204);
});

sessions.post('/pairing/create', async c => {
  if (c.req.header('Cookie')) fail(403, 'script_cookies_forbidden');
  await rate(c, 'pairing-create', 10);
  const input = await body(c, pairingCreateRequestSchema);
  if (input.client.kind !== 'userscript' || input.client.products.length !== 1 || new Set(input.client.namespaces).size !== input.client.namespaces.length) fail(400, 'invalid_client');
  const id = random(24), secret = random(), expires = now() + 600000;
  // Rejection sampling avoids biased short codes.
  let value: number; do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= 4200000000);
  const code = String(value % 100000000).padStart(8, '0');
  await c.env.DB.prepare('DELETE FROM pairings WHERE id IN(SELECT id FROM pairings WHERE expires<=? ORDER BY expires LIMIT 1000)').bind(now()).run();
  await c.env.DB.prepare('INSERT INTO pairings(id,client,code_hash,secret_hash,expires) VALUES(?,?,?,?,?)').bind(id, JSON.stringify(input.client), await hash(`${id}:${code}`), await hash(`${id}:${secret}`), expires).run();
  return c.json({ pairingId: id, secret, code, expiresAt: iso(expires) }, 201);
});
interface Pairing { id: string; client: string; expires: number; guesses: number; account_id: string | null; account_epoch: number | null; session_id: string | null; recovery: string | null; recovered_until: number | null }
async function pairingCode(c: Ctx, input: z.infer<typeof pairingApproveRequestSchema>) {
  await rate(c, 'pairing-code', 30);
  const proof = await hash(`${input.pairingId}:${input.code}`);
  const result = await c.env.DB.prepare(`UPDATE pairings SET guesses=guesses+1 WHERE id=? AND expires>? AND guesses<20 RETURNING code_hash,client,account_id`).bind(input.pairingId, now()).first<{ code_hash: string; client: string; account_id: string | null }>();
  if (!result) fail(410, 'pairing_unavailable');
  // Compare digests in constant time; database equality is only used on public
  // identifiers and on high-entropy refresh token hashes.
  const a = new TextEncoder().encode(proof), b = new TextEncoder().encode(result.code_hash);
  if (!timingSafeEqual(a, b)) fail(404, 'pairing_unavailable');
  return result;
}
sessions.post('/pairing/inspect', async c => {
  await authenticate(c); browser(c);
  const input = await body(c, pairingApproveRequestSchema), p = await pairingCode(c, input);
  return c.json({ pairingId: input.pairingId, client: JSON.parse(p.client), approved: p.account_id !== null });
});
sessions.post('/pairing/approve', async c => {
  const s = await authenticate(c); browser(c);
  const input = await body(c, pairingApproveRequestSchema); await pairingCode(c, input);
  const result = await c.env.DB.prepare(`UPDATE pairings SET account_id=?,account_epoch=? WHERE id=? AND account_id IS NULL AND expires>? AND guesses<=20
    AND EXISTS(SELECT 1 FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE a.id=? AND a.deleted_at IS NULL AND a.disabled_at IS NULL AND s.account_epoch=a.session_epoch AND s.id=? AND s.revoked_at IS NULL AND s.idle_expires>? AND s.absolute_expires>?)`)
    .bind(s.account_id, s.account_epoch ?? 0, input.pairingId, now(), s.account_id, s.id, now(), now()).run();
  if (!result.meta.changes) fail(409, 'pairing_unavailable');
  return c.body(null, 204);
});
sessions.post('/pairing/redeem', async c => {
  if (c.req.header('Cookie')) fail(403, 'script_cookies_forbidden');
  await rate(c, 'pairing-redeem', 60);
  const input = await body(c, pairingRedeemRequestSchema), proof = await hash(`${input.pairingId}:${input.secret}`);
  const p = await c.env.DB.prepare('SELECT * FROM pairings WHERE id=? AND secret_hash=?').bind(input.pairingId, proof).first<Pairing>();
  if (!p || p.expires <= now()) fail(410, 'pairing_unavailable');
  if (!p.account_id) fail(409, 'pairing_pending');
  if (p.account_epoch === null || !await c.env.DB.prepare('SELECT id FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL AND session_epoch=?').bind(p.account_id, p.account_epoch).first()) fail(410, 'pairing_unavailable');
  const { session, token } = newSession(p.account_id, JSON.parse(p.client) as Client), tokenHash = await hash(token);
  session.account_epoch = p.account_epoch;
  const recovery = await seal(c.env, token, `pairing:${p.id}`);
  await c.env.DB.batch([
    insertSession(c.env, session, tokenHash, 'EXISTS(SELECT 1 FROM pairings WHERE id=? AND secret_hash=? AND session_id IS NULL AND account_id=? AND expires>?)', [p.id, proof, p.account_id, now()]),
    c.env.DB.prepare(`UPDATE pairings SET session_id=?,recovery=?,recovered_until=? WHERE id=? AND session_id IS NULL AND EXISTS(SELECT 1 FROM sessions WHERE id=?)`).bind(session.id, recovery, now() + 120000, p.id, session.id),
  ]);
  const redeemed = await c.env.DB.prepare('SELECT * FROM pairings WHERE id=?').bind(p.id).first<Pairing>();
  if (!redeemed?.session_id || !redeemed.recovery || !redeemed.recovered_until || redeemed.recovered_until <= now()) fail(410, 'pairing_consumed');
  const s = await c.env.DB.prepare(`SELECT s.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND a.deleted_at IS NULL AND a.disabled_at IS NULL AND s.account_epoch=a.session_epoch`).bind(redeemed.session_id).first<Session>();
  const recovered = await unseal(c.env, redeemed.recovery, `pairing:${p.id}`);
  if (!active(s) || s.refresh_hash !== await hash(recovered)) fail(410, 'pairing_consumed');
  return tokens(c, s, recovered);
});
