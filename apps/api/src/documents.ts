import { Hono } from 'hono';
import { z } from 'zod';
import { decodeBase64url, encodeBase64url } from '@finance-tools/crypto';
import {
  documentDeleteRequestSchema,
  documentPutRequestSchema,
  encryptedEnvelopeSchema,
  idSchema,
  namespaceSchema,
  productSchema,
  vaultPutRequestSchema,
} from '@finance-tools/contracts';
import type {
  EncryptedEnvelope,
  Namespace,
  Product,
  StoredDocument,
  Vault,
  VaultResponse,
} from '@finance-tools/contracts';
import {
  ApiFailure,
  authenticate,
  body,
  browser,
  envelope,
  fail,
  hash,
  historyCutoff,
  iso,
  now,
  productScope,
  products,
  random,
  rate,
  scope,
} from './security';
import type { Bindings, Client, Ctx } from './security';

export const documents = new Hono<Bindings>();
interface Row {
  id: string;
  namespace: Namespace;
  product: Product;
  revision: number;
  blob_key: string | null;
  occurred_at: string | null;
  updated_at: string;
}
interface Receipt {
  hash: string;
  product: Product | null;
  status: number;
  response: string | null;
  blob_key: string | null;
  occurred_at: string | null;
}
function paths(c: Ctx) {
  const namespace = namespaceSchema.safeParse(c.req.param('namespace')),
    id = idSchema.safeParse(c.req.param('id'));
  if (!namespace.success || !id.success) fail(400, 'invalid_path');
  scope(c, namespace.data);
  return { namespace: namespace.data, id: id.data };
}
function payload(value: string | null | undefined): EncryptedEnvelope {
  try {
    const parsed = encryptedEnvelopeSchema.parse(JSON.parse(value ?? 'null'));
    envelope(parsed);
    return parsed;
  } catch {
    return fail(500, 'storage_unavailable');
  }
}
async function loadPayloads(c: Ctx, keys: string[]) {
  const rows = await c.env.DB.prepare(
    'SELECT key,envelope FROM blobs WHERE account_id=? AND key IN(SELECT value FROM json_each(?))',
  )
    .bind(c.get('session').account_id, JSON.stringify(keys))
    .all<{ key: string; envelope: string | null }>();
  return new Map(rows.results.map((row) => [row.key, row.envelope]));
}
async function stored(
  c: Ctx,
  row: Row,
  loaded?: Map<string, string | null>,
): Promise<StoredDocument> {
  if (!row.blob_key) fail(404, 'not_found');
  if (row.namespace === 'history' && (!row.occurred_at || row.occurred_at < historyCutoff()))
    fail(410, 'history_expired');
  const values = loaded ?? (await loadPayloads(c, [row.blob_key]));
  return {
    id: row.id,
    namespace: row.namespace,
    product: row.product,
    revision: row.revision,
    envelope: payload(values.get(row.blob_key)),
    updatedAt: row.updated_at,
    ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}),
  };
}
async function receipt(c: Ctx, namespace: string, id: string, mutation: string) {
  return c.env.DB.prepare(
    'SELECT hash,product,status,response,blob_key,occurred_at FROM mutations WHERE account_id=? AND namespace=? AND document_id=? AND id=?',
  )
    .bind(c.get('session').account_id, namespace, id, mutation)
    .first<Receipt>();
}
async function replay(c: Ctx, found: Receipt, payloadHash: string, namespace: string) {
  if (namespace !== 'vault') {
    if (!found.product) fail(403, 'product_scope');
    productScope(c, found.product);
  }
  if (found.hash !== payloadHash) fail(409, 'mutation_conflict');
  if (namespace === 'history' && found.occurred_at && found.occurred_at < historyCutoff())
    fail(410, 'history_expired');
  if (found.status === 204) return c.body(null, 204);
  if (!found.response) fail(410, 'history_expired');
  const response = JSON.parse(found.response);
  if (found.blob_key) {
    const values = await loadPayloads(c, [found.blob_key]);
    response.envelope = payload(values.get(found.blob_key));
  }
  return c.json(response);
}
interface Command {
  namespace: string;
  product?: Product;
  id: string;
  mutation: string;
  payloadHash: string;
  expected: number;
  blob?: string;
  envelope?: EncryptedEnvelope;
  occurredAt?: string;
  response?: string;
  vault?: string;
  keyVersion?: number;
  updatedAt: string;
}
async function command(c: Ctx, input: Command) {
  const s = c.get('session');
  try {
    await c.env.DB.prepare(
      `INSERT INTO commands(id,account_id,session_id,namespace,product,document_id,mutation_id,hash,expected,blob_key,envelope,occurred_at,response,vault,key_version,now,updated_at,cutoff)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        random(24),
        s.account_id,
        s.id,
        input.namespace,
        input.product ?? null,
        input.id,
        input.mutation,
        input.payloadHash,
        input.expected,
        input.blob ?? null,
        input.envelope ? JSON.stringify(input.envelope) : null,
        input.occurredAt ?? null,
        input.response ?? null,
        input.vault ?? null,
        input.keyVersion ?? null,
        now(),
        input.updatedAt,
        historyCutoff(),
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('inactive')) fail(401, 'unauthorized');
    if (message.includes('product_scope')) fail(403, 'product_scope');
    if (message.includes('namespace_scope')) fail(403, 'scope');
    if (message.includes('browser_required')) fail(403, 'browser_required');
    if (message.includes('expired_history')) fail(410, 'history_expired');
    if (message.includes('metadata_quota')) fail(413, 'metadata_quota_exceeded');
    if (message.includes('quota')) fail(413, 'quota_exceeded');
    if (message.includes('key_version')) fail(409, 'key_version_conflict');
    if (message.includes('mutation_conflict')) fail(409, 'mutation_conflict');
    if (message.includes('revision_conflict')) {
      const result =
        input.namespace === 'vault'
          ? await c.env.DB.prepare('SELECT vault_revision AS revision FROM accounts WHERE id=?')
              .bind(s.account_id)
              .first<{ revision: number }>()
          : await c.env.DB.prepare(
              'SELECT revision FROM documents WHERE account_id=? AND namespace=? AND id=?',
            )
              .bind(s.account_id, input.namespace, input.id)
              .first<{ revision: number }>();
      throw new ApiFailure(409, 'revision_conflict', 'Revision conflict', result?.revision ?? 0);
    }
    throw error;
  }
  const found = await receipt(c, input.namespace, input.id, input.mutation);
  if (!found) fail(500, 'mutation_unavailable');
  return replay(c, found, input.payloadHash, input.namespace);
}
documents.get('/vault', async (c) => {
  const s = await authenticate(c);
  const row = await c.env.DB.prepare(
    'SELECT vault,vault_revision FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL',
  )
    .bind(s.account_id)
    .first<{ vault: string | null; vault_revision: number }>();
  if (!row?.vault) fail(404, 'vault_uninitialized');
  return c.json({ revision: row.vault_revision, vault: JSON.parse(row.vault) });
});
documents.put('/vault', async (c) => {
  await authenticate(c);
  browser(c);
  await rate(c, `vault-write:${c.get('session').account_id}`, 60);
  const input = await body(c, vaultPutRequestSchema),
    payloadHash = await hash(JSON.stringify(input));
  const found = await receipt(c, 'vault', 'vault', input.mutationId);
  if (found) return replay(c, found, payloadHash, 'vault');
  for (const e of [input.vault.passphraseEnvelope, input.vault.recoveryEnvelope]) {
    if (e.keyVersion !== input.vault.keyVersion || envelope(e) !== 48) fail(400, 'invalid_vault');
  }
  try {
    if (decodeBase64url(input.vault.kdf.salt).length !== 16) fail(400, 'invalid_vault');
  } catch {
    fail(400, 'invalid_vault');
  }
  return command(c, {
    namespace: 'vault',
    id: 'vault',
    mutation: input.mutationId,
    payloadHash,
    expected: input.expectedRevision,
    vault: JSON.stringify(input.vault),
    keyVersion: input.vault.keyVersion,
    response: JSON.stringify({ revision: input.expectedRevision + 1, vault: input.vault }),
    updatedAt: iso(),
  });
});
documents.get('/documents/:namespace/:id', async (c) => {
  const s = await authenticate(c),
    { namespace, id } = paths(c);
  const row = await c.env.DB.prepare(
    'SELECT * FROM documents WHERE account_id=? AND namespace=? AND id=?',
  )
    .bind(s.account_id, namespace, id)
    .first<Row>();
  if (!row) fail(404, 'not_found');
  productScope(c, row.product);
  return c.json(await stored(c, row));
});
documents.put('/documents/:namespace/:id', async (c) => {
  const s = await authenticate(c),
    { namespace, id } = paths(c);
  await rate(c, `document-write:${s.account_id}`, 120);
  const input = await body(c, documentPutRequestSchema),
    payloadHash = await hash(JSON.stringify(input));
  productScope(c, input.product);
  const existing = await c.env.DB.prepare(
    'SELECT product FROM documents WHERE account_id=? AND namespace=? AND id=?',
  )
    .bind(s.account_id, namespace, id)
    .first<{ product: Product }>();
  if (existing) {
    productScope(c, existing.product);
    if (existing.product !== input.product) fail(409, 'product_immutable');
  }
  const found = await receipt(c, namespace, id, input.mutationId);
  if (found) return replay(c, found, payloadHash, namespace);
  envelope(input.envelope);
  if ((namespace === 'history') !== !!input.occurredAt)
    fail(400, 'occurred_at_required_for_history_only');
  const occurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : undefined;
  if (occurredAt && (occurredAt < historyCutoff() || occurredAt > iso()))
    fail(410, 'history_outside_retention');
  const blob = `${s.account_id}/${random(32)}`,
    time = now(),
    updatedAt = iso(time);
  const response = {
    id,
    namespace,
    product: input.product,
    revision: input.expectedRevision + 1,
    updatedAt,
    ...(occurredAt ? { occurredAt } : {}),
  };
  return command(c, {
    namespace,
    product: input.product,
    id,
    mutation: input.mutationId,
    payloadHash,
    expected: input.expectedRevision,
    blob,
    envelope: input.envelope,
    occurredAt,
    keyVersion: input.envelope.keyVersion,
    response: JSON.stringify(response),
    updatedAt,
  });
});
documents.delete('/documents/:namespace/:id', async (c) => {
  await authenticate(c);
  const { namespace, id } = paths(c);
  await rate(c, `document-write:${c.get('session').account_id}`, 120);
  const input = await body(c, documentDeleteRequestSchema),
    payloadHash = await hash(JSON.stringify(input));
  const existing = await c.env.DB.prepare(
    'SELECT product FROM documents WHERE account_id=? AND namespace=? AND id=?',
  )
    .bind(c.get('session').account_id, namespace, id)
    .first<{ product: Product }>();
  if (!existing) throw new ApiFailure(409, 'revision_conflict', 'Revision conflict', 0);
  productScope(c, existing.product);
  const found = await receipt(c, namespace, id, input.mutationId);
  if (found) return replay(c, found, payloadHash, namespace);
  return command(c, {
    namespace,
    product: existing.product,
    id,
    mutation: input.mutationId,
    payloadHash,
    expected: input.expectedRevision,
    updatedAt: iso(),
  });
});

const exportPositionSchema = z.tuple([namespaceSchema, idSchema, z.string().datetime()]);
async function cursor(c: Ctx, namespace: string, after: string, grants: Product[]) {
  const value = JSON.stringify({
    a: c.get('session').account_id,
    n: namespace,
    i: after,
    p: grants,
  });
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(c.env.ACCESS_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(value));
  return `${encodeBase64url(new TextEncoder().encode(value))}.${encodeBase64url(new Uint8Array(signature))}`;
}
async function afterCursor(c: Ctx, namespace: string, grants: Product[], value?: string) {
  if (!value) return '';
  if (value.length > 1024) fail(400, 'invalid_cursor');
  try {
    const [encoded, signature, extra] = value.split('.');
    if (extra) throw new Error();
    const data = decodeBase64url(encoded),
      payload = JSON.parse(new TextDecoder().decode(data));
    const k = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(c.env.ACCESS_JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify('HMAC', k, decodeBase64url(signature), data)) ||
      payload.a !== c.get('session').account_id ||
      payload.n !== namespace ||
      JSON.stringify(payload.p) !== JSON.stringify(grants) ||
      !(namespace.startsWith('export:')
        ? typeof payload.i === 'string' &&
          exportPositionSchema.safeParse(JSON.parse(payload.i)).success
        : idSchema.safeParse(payload.i).success)
    )
      throw new Error();
    return payload.i as string;
  } catch {
    return fail(400, 'invalid_cursor');
  }
}
documents.get('/documents/:namespace', async (c) => {
  const s = await authenticate(c),
    parsed = namespaceSchema.safeParse(c.req.param('namespace'));
  if (!parsed.success) fail(400, 'invalid_namespace');
  const namespace = parsed.data;
  scope(c, namespace);
  const query = z
    .object({
      cursor: z.string().optional(),
      product: productSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(100),
    })
    .strict()
    .safeParse(c.req.query());
  if (!query.success) fail(400, 'invalid_query');
  if (query.data.product) productScope(c, query.data.product);
  const grants = (query.data.product ? [query.data.product] : products(c)).slice().sort();
  const after = await afterCursor(c, namespace, grants, query.data.cursor);
  const rows = await c.env.DB.prepare(
    `SELECT d.*,COALESCE(b.bytes,0) AS bytes FROM documents d LEFT JOIN blobs b ON b.key=d.blob_key AND b.account_id=d.account_id WHERE d.account_id=? AND namespace=? AND id>? AND product IN(SELECT value FROM json_each(?)) AND blob_key IS NOT NULL AND (namespace<>'history' OR d.occurred_at>=?) ORDER BY id LIMIT ?`,
  )
    .bind(
      s.account_id,
      namespace,
      after,
      JSON.stringify(grants),
      historyCutoff(),
      query.data.limit + 1,
    )
    .all<Row & { bytes: number }>();
  const page: Row[] = [];
  let bytes = 0;
  for (const row of rows.results.slice(0, query.data.limit)) {
    const cost = row.bytes + 512; // allowance for response metadata/JSON punctuation
    if (page.length && bytes + cost > 2 * 1048576) break;
    page.push(row);
    bytes += cost;
  }
  const values = [];
  const loaded = await loadPayloads(
    c,
    page.map((row) => row.blob_key!),
  );
  for (const row of page) values.push(await stored(c, row, loaded));
  return c.json({
    documents: values,
    cursor:
      rows.results.length > page.length
        ? await cursor(c, namespace, page[page.length - 1].id, grants)
        : null,
  });
});
documents.get('/export', async (c) => {
  const s = await authenticate(c);
  browser(c);
  const grants = JSON.parse(s.client) as Client;
  const account = await c.env.DB.prepare(
    'SELECT vault,vault_revision FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL',
  )
    .bind(s.account_id)
    .first<{ vault: string | null; vault_revision: number }>();
  if (!account) fail(401, 'unauthorized');
  const vault: VaultResponse | null = account.vault
    ? { revision: account.vault_revision, vault: JSON.parse(account.vault) as Vault }
    : null;
  const query = z.object({ cursor: z.string().optional() }).strict().safeParse(c.req.query());
  if (!query.success) fail(400, 'invalid_query');
  const context = `export:${JSON.stringify(grants.namespaces.slice().sort())}`;
  const allowed = grants.products.slice().sort();
  const after = await afterCursor(c, context, allowed, query.data.cursor);
  const position = after ? exportPositionSchema.parse(JSON.parse(after)) : null;
  const afterNamespace = position?.[0] ?? '';
  const afterId = position?.[1] ?? '';
  const exportedAt = position?.[2] ?? iso();
  // Metadata-only lookahead, followed by one ownership-scoped payload query.
  // Export is not a snapshot: concurrent edits may appear on later pages.
  const rows = await c.env.DB.prepare(
    `SELECT d.*,COALESCE(b.bytes,0) AS bytes FROM documents d LEFT JOIN blobs b ON b.key=d.blob_key AND b.account_id=d.account_id
    WHERE d.account_id=? AND (d.namespace>? OR (d.namespace=? AND d.id>?))
    AND d.product IN(SELECT value FROM json_each(?)) AND d.namespace IN(SELECT value FROM json_each(?))
    AND d.blob_key IS NOT NULL AND (d.namespace<>'history' OR d.occurred_at>=?) ORDER BY d.namespace,d.id LIMIT 101`,
  )
    .bind(
      s.account_id,
      afterNamespace,
      afterNamespace,
      afterId,
      JSON.stringify(allowed),
      JSON.stringify(grants.namespaces),
      historyCutoff(),
    )
    .all<Row & { bytes: number }>();
  const page: Row[] = [];
  let bytes = 0;
  for (const row of rows.results.slice(0, 100)) {
    const cost = row.bytes + 512;
    if (page.length && bytes + cost > 2 * 1048576) break;
    page.push(row);
    bytes += cost;
  }
  const loaded = await loadPayloads(
    c,
    page.map((row) => row.blob_key!),
  );
  const values = [];
  for (const row of page) values.push(await stored(c, row, loaded));
  const last = page[page.length - 1];
  return c.json({
    version: 1,
    accountId: s.account_id,
    exportedAt,
    vault,
    documents: values,
    cursor:
      rows.results.length > page.length
        ? await cursor(c, context, JSON.stringify([last.namespace, last.id, exportedAt]), allowed)
        : null,
  });
});
