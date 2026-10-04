import { Hono } from 'hono';
import { z } from 'zod';
import { decodeBase64url, encodeBase64url } from '@finance-tools/crypto';
import { documentDeleteRequestSchema, documentPutRequestSchema, idSchema, namespaceSchema, productSchema, vaultPutRequestSchema } from '@finance-tools/contracts';
import type { EncryptedEnvelope, Namespace, Product, StoredDocument, Vault, VaultResponse } from '@finance-tools/contracts';
import { ApiFailure, authenticate, body, browser, envelope, fail, hash, historyCutoff, iso, now, productScope, products, random, rate, scope } from './security';
import type { Bindings, Client, Ctx } from './security';

export const documents = new Hono<Bindings>();
interface Row { id: string; namespace: Namespace; product: Product; revision: number; blob_key: string | null; occurred_at: string | null; updated_at: string }
interface Receipt { hash: string; product: Product | null; status: number; response: string | null; blob_key: string | null; occurred_at: string | null }
function paths(c: Ctx) {
  const namespace = namespaceSchema.safeParse(c.req.param('namespace')), id = idSchema.safeParse(c.req.param('id'));
  if (!namespace.success || !id.success) fail(400, 'invalid_path');
  scope(c, namespace.data); return { namespace: namespace.data, id: id.data };
}
async function stored(c: Ctx, row: Row): Promise<StoredDocument> {
  if (!row.blob_key) fail(404, 'not_found');
  if (row.namespace === 'history' && (!row.occurred_at || row.occurred_at < historyCutoff())) fail(410, 'history_expired');
  const object = await c.env.BLOBS.get(row.blob_key);
  if (!object) fail(500, 'storage_unavailable');
  return { id: row.id, namespace: row.namespace, product: row.product, revision: row.revision, envelope: JSON.parse(await object.text()) as EncryptedEnvelope, updatedAt: row.updated_at, ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}) };
}
async function receipt(c: Ctx, namespace: string, id: string, mutation: string) {
  return c.env.DB.prepare('SELECT hash,product,status,response,blob_key,occurred_at FROM mutations WHERE account_id=? AND namespace=? AND document_id=? AND id=?').bind(c.get('session').account_id, namespace, id, mutation).first<Receipt>();
}
async function replay(c: Ctx, found: Receipt, payloadHash: string, namespace: string) {
  if (namespace !== 'vault') {
    if (!found.product) fail(403, 'product_scope');
    productScope(c, found.product);
  }
  if (found.hash !== payloadHash) fail(409, 'mutation_conflict');
  if (namespace === 'history' && found.occurred_at && found.occurred_at < historyCutoff()) fail(410, 'history_expired');
  if (found.status === 204) return c.body(null, 204);
  if (!found.response) fail(410, 'history_expired');
  const response = JSON.parse(found.response);
  if (found.blob_key) {
    const object = await c.env.BLOBS.get(found.blob_key);
    if (!object) fail(500, 'storage_unavailable');
    response.envelope = JSON.parse(await object.text());
  }
  return c.json(response);
}
interface Command {
  namespace: string; product?: Product; id: string; mutation: string; payloadHash: string; expected: number;
  blob?: string; occurredAt?: string; response?: string; vault?: string; keyVersion?: number; updatedAt: string;
}
async function command(c: Ctx, input: Command) {
  const s = c.get('session');
  try {
    await c.env.DB.prepare(`INSERT INTO commands(id,account_id,session_id,namespace,product,document_id,mutation_id,hash,expected,blob_key,occurred_at,response,vault,key_version,now,updated_at,cutoff)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(random(24), s.account_id, s.id, input.namespace, input.product ?? null, input.id, input.mutation, input.payloadHash, input.expected, input.blob ?? null, input.occurredAt ?? null, input.response ?? null, input.vault ?? null, input.keyVersion ?? null, now(), input.updatedAt, historyCutoff()).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('inactive')) fail(401, 'unauthorized');
    if (message.includes('product_scope')) fail(403, 'product_scope');
    if (message.includes('expired_history')) fail(410, 'history_expired');
    if (message.includes('metadata_quota')) fail(413, 'metadata_quota_exceeded');
    if (message.includes('quota')) fail(413, 'quota_exceeded');
    if (message.includes('key_version')) fail(409, 'key_version_conflict');
    if (message.includes('mutation_conflict')) fail(409, 'mutation_conflict');
    if (message.includes('revision_conflict')) {
      const result = input.namespace === 'vault'
        ? await c.env.DB.prepare('SELECT vault_revision AS revision FROM accounts WHERE id=?').bind(s.account_id).first<{ revision: number }>()
        : await c.env.DB.prepare('SELECT revision FROM documents WHERE account_id=? AND namespace=? AND id=?').bind(s.account_id, input.namespace, input.id).first<{ revision: number }>();
      throw new ApiFailure(409, 'revision_conflict', 'Revision conflict', result?.revision ?? 0);
    }
    throw error;
  }
  const found = await receipt(c, input.namespace, input.id, input.mutation);
  if (!found) fail(500, 'mutation_unavailable');
  return replay(c, found, input.payloadHash, input.namespace);
}
documents.get('/vault', async c => {
  const s = await authenticate(c);
  const row = await c.env.DB.prepare('SELECT vault,vault_revision FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL').bind(s.account_id).first<{ vault: string | null; vault_revision: number }>();
  if (!row?.vault) fail(404, 'vault_uninitialized');
  return c.json({ revision: row.vault_revision, vault: JSON.parse(row.vault) });
});
documents.put('/vault', async c => {
  await authenticate(c); browser(c);
  await rate(c, `vault-write:${c.get('session').account_id}`, 60);
  const input = await body(c, vaultPutRequestSchema), payloadHash = await hash(JSON.stringify(input));
  const found = await receipt(c, 'vault', 'vault', input.mutationId); if (found) return replay(c, found, payloadHash, 'vault');
  for (const e of [input.vault.passphraseEnvelope, input.vault.recoveryEnvelope]) {
    if (e.keyVersion !== input.vault.keyVersion || envelope(e) !== 48) fail(400, 'invalid_vault');
  }
  try { if (decodeBase64url(input.vault.kdf.salt).length !== 16) fail(400, 'invalid_vault'); } catch { fail(400, 'invalid_vault'); }
  return command(c, { namespace: 'vault', id: 'vault', mutation: input.mutationId, payloadHash, expected: input.expectedRevision, vault: JSON.stringify(input.vault), keyVersion: input.vault.keyVersion, response: JSON.stringify({ revision: input.expectedRevision + 1, vault: input.vault }), updatedAt: iso() });
});
documents.get('/documents/:namespace/:id', async c => {
  const s = await authenticate(c), { namespace, id } = paths(c);
  const row = await c.env.DB.prepare('SELECT * FROM documents WHERE account_id=? AND namespace=? AND id=?').bind(s.account_id, namespace, id).first<Row>();
  if (!row) fail(404, 'not_found'); productScope(c, row.product); return c.json(await stored(c, row));
});
documents.put('/documents/:namespace/:id', async c => {
  const s = await authenticate(c), { namespace, id } = paths(c);
  await rate(c, `document-write:${s.account_id}`, 120);
  const input = await body(c, documentPutRequestSchema), payloadHash = await hash(JSON.stringify(input));
  productScope(c, input.product);
  const existing = await c.env.DB.prepare('SELECT product FROM documents WHERE account_id=? AND namespace=? AND id=?').bind(s.account_id, namespace, id).first<{ product: Product }>();
  if (existing) { productScope(c, existing.product); if (existing.product !== input.product) fail(409, 'product_immutable'); }
  const found = await receipt(c, namespace, id, input.mutationId); if (found) return replay(c, found, payloadHash, namespace);
  envelope(input.envelope);
  const size = new TextEncoder().encode(JSON.stringify(input.envelope)).length;
  if ((namespace === 'history') !== !!input.occurredAt) fail(400, 'occurred_at_required_for_history_only');
  const occurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : undefined;
  if (occurredAt && (occurredAt < historyCutoff() || occurredAt > iso())) fail(410, 'history_outside_retention');
  const blob = `${s.account_id}/${random(32)}`, time = now(), updatedAt = iso(time);
  // Register before uploading. Cleanup first marks expired pending keys deleting;
  // the commit trigger refuses those keys. Object keys are never reused.
  const pending = await c.env.DB.prepare(`INSERT INTO blobs(key,account_id,bytes,state,expires,occurred_at,created_at)
    SELECT ?,?,?,'pending',?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL)
    AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND account_id=? AND account_epoch=(SELECT session_epoch FROM accounts WHERE id=?)
      AND revoked_at IS NULL AND idle_expires>? AND absolute_expires>?)
    AND (SELECT COALESCE(SUM(bytes),0) FROM blobs WHERE account_id=?)+? <= (SELECT max_bytes FROM accounts WHERE id=?)`)
    .bind(blob, s.account_id, size, time + 3600000, occurredAt ?? null, time, s.account_id, s.id, s.account_id, s.account_id, time, time, s.account_id, size, s.account_id).run();
  if (!pending.meta.changes) fail(413, 'quota_exceeded');
  try {
    const uploaded = await c.env.BLOBS.put(blob, JSON.stringify(input.envelope), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (!uploaded) fail(500, 'storage_unavailable');
    const response = { id, namespace, product: input.product, revision: input.expectedRevision + 1, updatedAt, ...(occurredAt ? { occurredAt } : {}) };
    return await command(c, { namespace, product: input.product, id, mutation: input.mutationId, payloadHash, expected: input.expectedRevision, blob, occurredAt, keyVersion: input.envelope.keyVersion, response: JSON.stringify(response), updatedAt });
  } finally {
    // A failed CAS/replayed concurrent mutation must not leave its upload live.
    await c.env.DB.prepare("UPDATE blobs SET state='deleting' WHERE key=? AND state='pending'").bind(blob).run();
  }
});
documents.delete('/documents/:namespace/:id', async c => {
  await authenticate(c); const { namespace, id } = paths(c);
  await rate(c, `document-write:${c.get('session').account_id}`, 120);
  const input = await body(c, documentDeleteRequestSchema), payloadHash = await hash(JSON.stringify(input));
  const existing = await c.env.DB.prepare('SELECT product FROM documents WHERE account_id=? AND namespace=? AND id=?').bind(c.get('session').account_id, namespace, id).first<{ product: Product }>();
  if (!existing) throw new ApiFailure(409, 'revision_conflict', 'Revision conflict', 0);
  productScope(c, existing.product);
  const found = await receipt(c, namespace, id, input.mutationId); if (found) return replay(c, found, payloadHash, namespace);
  return command(c, { namespace, product: existing.product, id, mutation: input.mutationId, payloadHash, expected: input.expectedRevision, updatedAt: iso() });
});

async function cursor(c: Ctx, namespace: string, after: string, grants: Product[]) {
  const value = JSON.stringify({ a: c.get('session').account_id, n: namespace, i: after, p: grants });
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.ACCESS_JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(value));
  return `${encodeBase64url(new TextEncoder().encode(value))}.${encodeBase64url(new Uint8Array(signature))}`;
}
async function afterCursor(c: Ctx, namespace: string, grants: Product[], value?: string) {
  if (!value) return '';
  if (value.length > 1024) fail(400, 'invalid_cursor');
  try {
    const [encoded, signature, extra] = value.split('.'); if (extra) throw new Error();
    const data = decodeBase64url(encoded), payload = JSON.parse(new TextDecoder().decode(data));
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.ACCESS_JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', k, decodeBase64url(signature), data) || payload.a !== c.get('session').account_id || payload.n !== namespace || JSON.stringify(payload.p) !== JSON.stringify(grants) || !idSchema.safeParse(payload.i).success) throw new Error();
    return payload.i as string;
  } catch { return fail(400, 'invalid_cursor'); }
}
documents.get('/documents/:namespace', async c => {
  const s = await authenticate(c), parsed = namespaceSchema.safeParse(c.req.param('namespace'));
  if (!parsed.success) fail(400, 'invalid_namespace'); const namespace = parsed.data; scope(c, namespace);
  const query = z.object({ cursor: z.string().optional(), product: productSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict().safeParse(c.req.query());
  if (!query.success) fail(400, 'invalid_query');
  if (query.data.product) productScope(c, query.data.product);
  const grants = (query.data.product ? [query.data.product] : products(c)).slice().sort();
  const after = await afterCursor(c, namespace, grants, query.data.cursor);
  const rows = await c.env.DB.prepare(`SELECT d.*,b.bytes FROM documents d JOIN blobs b ON b.key=d.blob_key WHERE d.account_id=? AND namespace=? AND id>? AND product IN(SELECT value FROM json_each(?)) AND blob_key IS NOT NULL AND (namespace<>'history' OR d.occurred_at>=?) ORDER BY id LIMIT ?`).bind(s.account_id, namespace, after, JSON.stringify(grants), historyCutoff(), query.data.limit + 1).all<Row & { bytes: number }>();
  const page: Row[] = []; let bytes = 0;
  for (const row of rows.results.slice(0, query.data.limit)) {
    const cost = row.bytes + 512; // allowance for response metadata/JSON punctuation
    if (page.length && bytes + cost > 2 * 1048576) break;
    page.push(row); bytes += cost;
  }
  const values = [];
  for (const row of page) values.push(await stored(c, row));
  return c.json({ documents: values, cursor: rows.results.length > page.length ? await cursor(c, namespace, page[page.length - 1].id, grants) : null });
});
documents.get('/export', async c => {
  const s = await authenticate(c); browser(c);
  const grants = JSON.parse(s.client) as Client;
  const account = await c.env.DB.prepare('SELECT vault,vault_revision FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL').bind(s.account_id).first<{ vault: string | null; vault_revision: number }>();
  if (!account) fail(401, 'unauthorized');
  const vault: VaultResponse | null = account.vault ? { revision: account.vault_revision, vault: JSON.parse(account.vault) as Vault } : null;
  const encoder = new TextEncoder();
  // Pull-based streaming bounds memory to one envelope. Export is an encrypted
  // read, not an atomic snapshot; concurrent edits may appear in later pages.
  let afterNamespace = '', afterId = '', started = false, finished = false;
  let page: Row[] = [];
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    try {
      if (!started) {
        controller.enqueue(encoder.encode(JSON.stringify({ version: 1, accountId: s.account_id, exportedAt: iso(), vault }).slice(0, -1) + ',"documents":['));
        started = true;
      }
      if (!page.length) {
        // Seek in the composite primary key, rather than issuing one D1 scan
        // per object. Recheck authorization at each metadata page boundary.
        const current = await c.env.DB.prepare(`SELECT id FROM sessions WHERE id=? AND revoked_at IS NULL AND idle_expires>? AND absolute_expires>?
          AND EXISTS(SELECT 1 FROM accounts WHERE id=sessions.account_id AND deleted_at IS NULL AND disabled_at IS NULL AND session_epoch=sessions.account_epoch)`).bind(s.id, now(), now()).first();
        if (!current) throw new Error('Session revoked');
        const rows = await c.env.DB.prepare(`SELECT * FROM documents WHERE account_id=? AND (namespace>? OR (namespace=? AND id>?))
          AND product IN(SELECT value FROM json_each(?)) AND namespace IN(SELECT value FROM json_each(?))
          AND blob_key IS NOT NULL AND (namespace<>'history' OR occurred_at>=?) ORDER BY namespace,id LIMIT 100`)
          .bind(s.account_id, afterNamespace, afterNamespace, afterId, JSON.stringify(grants.products), JSON.stringify(grants.namespaces), historyCutoff()).all<Row>();
        page = rows.results;
      }
      const row = page.shift();
      if (!row) { controller.enqueue(encoder.encode(']}')); controller.close(); return; }
      const value = await stored(c, row);
      controller.enqueue(encoder.encode((finished ? ',' : '') + JSON.stringify(value))); finished = true;
      afterNamespace = row.namespace; afterId = row.id;
    } catch { controller.error(new Error('Export interrupted')); }
  } });
  return new Response(stream, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
});
