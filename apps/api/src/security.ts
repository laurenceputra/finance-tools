import { SignJWT, jwtVerify } from 'jose';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { decodeBase64url, encodeBase64url } from '@finance-tools/crypto';
import { clientSchema, MAX_REQUEST_BODY_BYTES, MAX_DOCUMENT_BYTES } from '@finance-tools/contracts';
import { eligibilityStatements } from './eligibility';
import type { EncryptedEnvelope, Product } from '@finance-tools/contracts';
import type { Context } from 'hono';
import type { z } from 'zod';

export type Bindings = { Bindings: Env; Variables: { session: Session; requestId: string } };
export type Ctx = Context<Bindings>;
export interface Session {
  id: string; account_id: string; client: string; created_at: number; last_used_at: number;
  idle_expires: number; absolute_expires: number; revoked_at: number | null; refresh_hash: string; account_epoch?: number;
}
export type Client = z.infer<typeof clientSchema>;
export class ApiFailure extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500, public code: string, message = code, public currentRevision?: number) { super(message); }
}
export function fail(status: ApiFailure['status'], code: string): never { throw new ApiFailure(status, code); }
export const now = () => Date.now();
export const iso = (time = now()) => new Date(time).toISOString();
export const random = (bytes = 32) => encodeBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function hash(value: string) { return encodeBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
export function key(secret: string) {
  const bytes = decodeBase64url(secret);
  if (bytes.length !== 32) throw new Error('Server key not configured');
  return bytes;
}
export async function seal(env: Env, text: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', key(env.SESSION_WRAP_SECRET), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, k, new TextEncoder().encode(text));
  return `${encodeBase64url(iv)}.${encodeBase64url(new Uint8Array(encrypted))}`;
}
export async function unseal(env: Env, text: string, context: string) {
  const [iv, data] = text.split('.');
  const k = await crypto.subtle.importKey('raw', key(env.SESSION_WRAP_SECRET), 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64url(iv), additionalData: new TextEncoder().encode(context) }, k, decodeBase64url(data)));
}
const ISSUER = 'https://finance.laurenceputra.com';
const AUDIENCE = 'finance-tools-api-v1';
export async function accessToken(env: Env, session: Session) {
  const client = JSON.parse(session.client) as Client;
  return new SignJWT({ sid: session.id, scopes: client.namespaces, products: client.products })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setSubject(session.account_id).setIssuedAt().setExpirationTime('15m').setJti(random(16)).sign(key(env.ACCESS_JWT_SECRET));
}
export async function authenticate(c: Ctx) {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ') || auth.length > 8192) fail(401, 'unauthorized');
  let subject: string | undefined, sid: string;
  try {
    const { payload } = await jwtVerify(auth.slice(7), key(c.env.ACCESS_JWT_SECRET), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, typ: 'JWT', requiredClaims: ['exp', 'iat', 'sub', 'sid', 'jti'] });
    if (typeof payload.sid !== 'string' || !payload.sub || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp - payload.iat > 900) fail(401, 'unauthorized');
    subject = payload.sub; sid = payload.sid;
  } catch { return fail(401, 'unauthorized'); }
  const session = await c.env.DB.prepare(`SELECT s.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.account_id=? AND a.deleted_at IS NULL AND a.disabled_at IS NULL AND s.account_epoch=a.session_epoch AND s.revoked_at IS NULL AND s.idle_expires>? AND s.absolute_expires>?`).bind(sid, subject, now(), now()).first<Session>();
  if (!session) fail(401, 'unauthorized');
  const parsed = clientSchema.safeParse(JSON.parse(session.client));
  if (!parsed.success) fail(401, 'client_upgrade_required');
  const client = parsed.data;
  if (client.kind === 'userscript' && c.req.header('Cookie')) fail(403, 'script_cookies_forbidden');
  if (client.kind === 'browser' && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) csrf(c);
  c.set('session', session);
  return session;
}
export function csrf(c: Ctx) {
  if (c.req.header('Origin') !== c.env.APP_ORIGIN || c.req.header('X-Finance-CSRF') !== '1') fail(403, 'csrf');
}
export function browser(c: Ctx) {
  if ((JSON.parse(c.get('session').client) as Client).kind !== 'browser') fail(403, 'browser_required');
}
export function scope(c: Ctx, namespace: 'settings' | 'history') {
  if (!(JSON.parse(c.get('session').client) as Client).namespaces.includes(namespace)) fail(403, 'scope');
}
export function products(c: Ctx): Product[] { return (JSON.parse(c.get('session').client) as Client).products; }
export function productScope(c: Ctx, product: Product) {
  if (!products(c).includes(product)) fail(403, 'product_scope');
}
export async function clerkSubject(c: Ctx, token: string, stepUp = false) {
  let verified;
  try {
    if (!c.env.CLERK_ISSUER || !c.env.CLERK_AUDIENCE) throw new Error('Missing Clerk configuration');
    verified = await verifyToken(token, { secretKey: c.env.CLERK_SECRET_KEY, jwtKey: c.env.CLERK_JWT_KEY || undefined, audience: c.env.CLERK_AUDIENCE, authorizedParties: [c.env.APP_ORIGIN], clockSkewInMs: 0 });
    // verifyToken validates the signature, audience, exp/nbf and azp. Issuer and
    // token freshness are deliberately checked here, not on an unverified JWT.
    const seconds = Math.floor(now() / 1000);
    if (verified.iss !== c.env.CLERK_ISSUER || verified.azp !== c.env.APP_ORIGIN || !verified.sub || !verified.sid || typeof verified.iat !== 'number' || verified.iat > seconds || seconds - verified.iat > 300) throw new Error('Invalid Clerk session');
    if ('sts' in verified && verified.sts !== 'active') throw new Error('Inactive Clerk session');
  } catch { return fail(401, 'fresh_clerk_required'); }
  const user = await createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY }).users.getUser(verified.sub);
  if (user.id !== verified.sub || typeof user.banned !== 'boolean' || !Number.isSafeInteger(user.updatedAt) || user.updatedAt < 0) fail(403, 'clerk_user_ineligible');
  await c.env.DB.batch(eligibilityStatements(c.env, verified.sub, user.banned, user.updatedAt, now(), !stepUp));
  if (user.banned) fail(403, 'account_disabled');
  if (stepUp) {
    const ages = verified.fva;
    if (!Array.isArray(ages) || ages.length !== 2 || !ages.every(age => Number.isInteger(age) && age >= -1)) fail(403, 'reverification_required');
    // fva is measured in whole minutes at issuance. Include the age of the
    // token itself so a cached token cannot extend the verification window.
    // Allow for the claim's whole-minute quantization conservatively: the
    // upper bound of that minute, plus elapsed token age, must fit five minutes.
    const fresh = (age: number) => age >= 0 && age + 1 + (now() / 1000 - verified.iat) / 60 <= 5;
    if (!fresh(ages[0])) fail(403, 'reverification_required');
    // fva[1] == -1 cannot distinguish no enrollment from an enrolled but
    // unverified factor. Consult trusted Clerk state; never trust client hints.
    if (user.id !== verified.sub || typeof user.twoFactorEnabled !== 'boolean') fail(403, 'reverification_required');
    if (!fresh(ages[0])) fail(403, 'reverification_required');
    if (user.twoFactorEnabled && !fresh(ages[1])) fail(403, 'mfa_reverification_required');
  }
  return verified.sub;
}
export async function boundedBody(request: Request, limit = MAX_REQUEST_BODY_BYTES): Promise<string> {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) fail(413, 'body_too_large');
  if (!request.body) return '';
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); fail(413, 'body_too_large'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(total); let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.length; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { return fail(400, 'invalid_body'); }
}
export async function body<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(400, 'json_required');
  const raw = await boundedBody(c.req.raw);
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'envelope' in value && value.envelope && typeof value.envelope === 'object'
      && 'ciphertext' in value.envelope && typeof value.envelope.ciphertext === 'string'
      && value.envelope.ciphertext.length > Math.ceil(MAX_DOCUMENT_BYTES * 4 / 3)) fail(413, 'document_too_large');
    return schema.parse(value);
  } catch (error) { if (error instanceof ApiFailure) throw error; return fail(400, 'invalid_body'); }
}
export function envelope(input: EncryptedEnvelope) {
  try {
    const ciphertext = decodeBase64url(input.ciphertext);
    if (decodeBase64url(input.iv).length !== 12 || ciphertext.length < 16) fail(400, 'invalid_envelope');
    if (ciphertext.length > MAX_DOCUMENT_BYTES) fail(413, 'document_too_large');
    return ciphertext.length;
  } catch (e) { if (e instanceof ApiFailure) throw e; return fail(400, 'invalid_envelope'); }
}
export function historyCutoff(time = now()): string {
  const date = new Date(time), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - 3);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last)); return date.toISOString();
}
export async function rate(c: Ctx, category: string, limit: number, windowMs = 600000) {
  const bucket = Math.floor(now() / windowMs);
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const k = await hash(`${category}:${ip}:${bucket}`);
  // Remove only expired buckets; live limiter history is never discarded to
  // admit an attacker rotating IPs. Existing keys can increment at capacity.
  await c.env.DB.prepare('DELETE FROM rate_limits WHERE key IN(SELECT key FROM rate_limits WHERE expires<=? ORDER BY expires LIMIT 100)').bind(now()).run();
  const row = await c.env.DB.prepare(`INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(k, (bucket + 1) * windowMs).first<{ count: number }>();
  if (!row || row.count > limit) fail(429, 'rate_limited');
}
