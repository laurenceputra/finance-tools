import { Hono } from 'hono';
import {
  isStandardVault,
  vaultMetadataSchema,
  vaultModeRequestSchema,
} from '@finance-tools/contracts';
import { decodeBase64url, encodeBase64url } from '@finance-tools/crypto';
import {
  authenticate,
  body,
  browser,
  clerkSubject,
  envelope,
  fail,
  hash,
  key,
  now,
  rate,
  ApiFailure,
} from './security';
import type { Bindings, Ctx } from './security';

export const vaults = new Hono<Bindings>();
const context = (account: string, version: number) =>
  new TextEncoder().encode(
    JSON.stringify(['finance-tools', 'server-vault-wrap', 1, account, version]),
  );
async function wrappingKey(env: Env) {
  try {
    return await crypto.subtle.importKey('raw', key(env.VAULT_WRAP_SECRET), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    return fail(500, 'vault_wrap_not_configured');
  }
}
async function wrap(env: Env, account: string, version: number, raw: Uint8Array<ArrayBuffer>) {
  const k = await wrappingKey(env),
    iv = crypto.getRandomValues(new Uint8Array(12));
  return `1.${encodeBase64url(iv)}.${encodeBase64url(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(account, version) }, k, raw)))}`;
}
async function unwrap(env: Env, account: string, version: number, value: string) {
  const k = await wrappingKey(env);
  try {
    const [format, iv, ciphertext, extra] = value.split('.');
    if (format !== '1' || extra) fail(500, 'vault_wrap_unavailable');
    const raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decodeBase64url(iv), additionalData: context(account, version) },
        k,
        decodeBase64url(ciphertext),
      ),
    );
    if (raw.length !== 32) {
      raw.fill(0);
      fail(500, 'vault_wrap_unavailable');
    }
    return raw;
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    return fail(500, 'vault_wrap_unavailable');
  }
}
// The SQL predicate is rechecked at commit/release, not merely at JWT authentication.
function eligibility(c: Ctx) {
  const s = c.get('session');
  return c.env.DB.prepare(
    `SELECT a.vault,a.vault_revision,a.server_vault_wrap FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE a.id=? AND s.id=? AND a.deleted_at IS NULL AND a.disabled_at IS NULL AND s.account_epoch=a.session_epoch AND s.revoked_at IS NULL AND s.idle_expires>? AND s.absolute_expires>?`,
  ).bind(s.account_id, s.id, now(), now());
}
export async function initializeStandard(env: Env, account: string, epoch: number) {
  const existing = await env.DB.prepare('SELECT vault FROM accounts WHERE id=?')
    .bind(account)
    .first<{ vault: string | null }>();
  if (existing?.vault) return;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const sealed = await wrap(env, account, 1, raw);
    await env.DB.prepare(
      `UPDATE accounts SET vault=?,vault_revision=1,key_version=1,server_vault_wrap=? WHERE id=? AND vault IS NULL AND deleted_at IS NULL AND disabled_at IS NULL AND session_epoch=? AND metadata_bytes+1024<metadata_limit`,
    )
      .bind(JSON.stringify({ version: 2, mode: 'standard', keyVersion: 1 }), sealed, account, epoch)
      .run();
    const winner = await env.DB.prepare(
      'SELECT vault FROM accounts WHERE id=? AND deleted_at IS NULL AND disabled_at IS NULL AND session_epoch=?',
    )
      .bind(account, epoch)
      .first<{ vault: string | null }>();
    if (!winner?.vault) fail(403, 'account_unavailable');
  } finally {
    raw.fill(0);
  }
}
vaults.post('/vault/key', async (c) => {
  const s = await authenticate(c);
  const requested = await body(c, vaultModeRequestSchema.pick({ expectedRevision: true }));
  const input = await eligibility(c).first<{
    vault: string;
    vault_revision: number;
    server_vault_wrap: string | null;
  }>();
  if (!input) fail(401, 'unauthorized');
  if (!input.vault) fail(404, 'vault_uninitialized');
  if (input.vault_revision !== requested.expectedRevision) fail(409, 'revision_conflict');
  const metadata = vaultMetadataSchema.parse(JSON.parse(input.vault));
  // Paired userscripts already have explicit namespace/product grants; authenticate validates their persisted client.
  if (!isStandardVault(metadata) || !input.server_vault_wrap) fail(409, 'private_key_required');
  const raw = await unwrap(c.env, s.account_id, metadata.keyVersion, input.server_vault_wrap);
  try {
    const current = await eligibility(c).first<{
      vault: string;
      vault_revision: number;
      server_vault_wrap: string | null;
    }>();
    if (!current) fail(401, 'unauthorized');
    if (
      current.vault_revision !== input.vault_revision ||
      current.vault !== input.vault ||
      current.server_vault_wrap !== input.server_vault_wrap
    )
      fail(409, 'revision_conflict');
    return c.json({
      revision: input.vault_revision,
      keyVersion: metadata.keyVersion,
      rawKey: encodeBase64url(raw),
    });
  } finally {
    raw.fill(0);
  }
});
vaults.put('/vault/mode', async (c) => {
  const s = await authenticate(c);
  browser(c);
  await rate(c, `vault-mode:${s.account_id}`, 20);
  const input = await body(c, vaultModeRequestSchema);
  const subject = await clerkSubject(c, input.clerkToken, true);
  const account = await c.env.DB.prepare('SELECT subject FROM accounts WHERE id=?')
    .bind(s.account_id)
    .first<{ subject: string }>();
  if (account?.subject !== subject) fail(403, 'subject_mismatch');
  const digest = await hash(JSON.stringify({ ...input, clerkToken: undefined }));
  const receipt = () =>
    c.env.DB.prepare(
      "SELECT hash,response FROM mutations WHERE account_id=? AND namespace='vault-mode' AND document_id='vault' AND id=?",
    )
      .bind(s.account_id, input.mutationId)
      .first<{ hash: string; response: string }>();
  const old = await receipt();
  if (old) {
    if (!(await eligibility(c).first())) fail(401, 'unauthorized');
    if (old.hash !== digest) fail(409, 'mutation_conflict');
    return c.json({ revision: JSON.parse(old.response).revision, vault: input.vault });
  }
  const current = await eligibility(c).first<{ vault: string; vault_revision: number }>();
  if (!current) fail(401, 'unauthorized');
  const prior = vaultMetadataSchema.parse(JSON.parse(current.vault));
  if (
    current.vault_revision !== input.expectedRevision ||
    prior.keyVersion !== input.vault.keyVersion
  )
    fail(409, 'revision_conflict');
  const standard = isStandardVault(input.vault);
  if (standard === isStandardVault(prior)) fail(409, 'mode_unchanged');
  let sealed: string | null = null;
  if (standard) {
    if (!input.rawKey || !input.trustServer) fail(400, 'server_trust_required');
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = decodeBase64url(input.rawKey);
    } catch {
      return fail(400, 'invalid_key');
    }
    try {
      sealed = await wrap(c.env, s.account_id, prior.keyVersion, raw);
    } finally {
      raw.fill(0);
    }
  } else {
    if (input.rawKey) fail(400, 'invalid_body');
    if (isStandardVault(input.vault)) fail(400, 'invalid_body');
    for (const e of [input.vault.passphraseEnvelope, input.vault.recoveryEnvelope])
      if (e.keyVersion !== prior.keyVersion || envelope(e) !== 48) fail(400, 'invalid_vault');
    try {
      if (decodeBase64url(input.vault.kdf.salt).length !== 16) fail(400, 'invalid_vault');
    } catch {
      return fail(400, 'invalid_vault');
    }
  }
  const response = JSON.stringify({
    revision: input.expectedRevision + 1,
    mode: standard ? 'standard' : 'private',
    keyVersion: input.vault.keyVersion,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE accounts SET vault=?,vault_revision=vault_revision+1,server_vault_wrap=?,vault_mutation=? WHERE id=? AND vault_revision=? AND key_version=? AND deleted_at IS NULL AND disabled_at IS NULL AND metadata_bytes+4096<metadata_limit AND receipt_count<receipt_limit AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=? AND s.account_id=accounts.id AND s.account_epoch=accounts.session_epoch AND s.revoked_at IS NULL AND s.idle_expires>? AND s.absolute_expires>?) AND NOT EXISTS(SELECT 1 FROM mutations WHERE account_id=accounts.id AND namespace='vault-mode' AND document_id='vault' AND id=?)`,
    ).bind(
      JSON.stringify(input.vault),
      sealed,
      input.mutationId,
      s.account_id,
      input.expectedRevision,
      prior.keyVersion,
      s.id,
      now(),
      now(),
      input.mutationId,
    ),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO mutations(account_id,namespace,document_id,id,hash,status,response,created_at,metadata_size) SELECT id,'vault-mode','vault',?,?,200,?,?,? FROM accounts WHERE id=? AND vault_mutation=? AND vault_revision=?`,
    ).bind(
      input.mutationId,
      digest,
      response,
      now(),
      512 + new TextEncoder().encode(response).length,
      s.account_id,
      input.mutationId,
      input.expectedRevision + 1,
    ),
  ]);
  const committed = await receipt();
  if (!committed) fail(409, 'revision_conflict');
  if (committed.hash !== digest) fail(409, 'mutation_conflict');
  return c.json({ revision: JSON.parse(committed.response).revision, vault: input.vault });
});
