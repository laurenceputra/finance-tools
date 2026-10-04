import { Hono } from 'hono';
import { Webhook } from 'svix';
import { accountDeleteRequestSchema } from '@finance-tools/contracts';
import {
  authenticate,
  body,
  boundedBody,
  browser,
  clerkSubject,
  csrf,
  fail,
  historyCutoff,
  now,
  random,
  rate,
} from './security';
import type { Bindings } from './security';
import { cookie } from './sessions';
import { eligibilityStatements } from './eligibility';

export const lifecycle = new Hono<Bindings>();
export function disable(
  env: Env,
  subject: string,
  time: number,
  acceptance?: { id: string; nonce: string },
) {
  // Never delete the accounts row. A durable subject tombstone prevents delayed
  // exchange, webhook retries or in-flight uploads from reprovisioning it.
  const guard = acceptance ? 'EXISTS(SELECT 1 FROM webhooks WHERE id=? AND acceptance_id=?)' : '1';
  const args = acceptance ? [acceptance.id, acceptance.nonce] : [];
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO accounts(id,subject,created_at,deleted_at,cleanup_pending) SELECT ?,?,?,?,1 WHERE ${guard}`,
    ).bind(random(24), subject, time, time, ...args),
    env.DB.prepare(
      `UPDATE accounts SET deleted_at=COALESCE(deleted_at,?),vault=NULL,key_version=NULL,cleanup_pending=1 WHERE subject=? AND ${guard}`,
    ).bind(time, subject, ...args),
  ];
}
lifecycle.delete('/account', async (c) => {
  csrf(c);
  await rate(c, 'delete-account', 20);
  const input = await body(c, accountDeleteRequestSchema),
    subject = await clerkSubject(c, input.clerkToken, true);
  const account = await c.env.DB.prepare('SELECT id,deleted_at FROM accounts WHERE subject=?')
    .bind(subject)
    .first<{ id: string; deleted_at: number | null }>();
  if (!account || account.deleted_at === null) {
    const s = await authenticate(c);
    browser(c);
    if (!account || s.account_id !== account.id) fail(403, 'subject_mismatch');
  }
  // Deleted accounts can retry with fresh Clerk proof even though own access
  // tokens were immediately revoked by the first successful request.
  await c.env.DB.batch(disable(c.env, subject, now()));
  cookie(c);
  return c.body(null, 204);
});
lifecycle.post('/webhooks/clerk', async (c) => {
  const raw = await boundedBody(c.req.raw, 262144);
  const id = c.req.header('svix-id'),
    timestamp = c.req.header('svix-timestamp'),
    signature = c.req.header('svix-signature');
  if (!id || id.length > 256 || !timestamp || !signature || signature.length > 4096)
    fail(400, 'invalid_webhook');
  let verified: unknown;
  try {
    verified = new Webhook(c.env.CLERK_WEBHOOK_SECRET).verify(raw, {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    });
  } catch {
    return fail(401, 'invalid_webhook');
  }
  if (!verified || typeof verified !== 'object' || !('type' in verified))
    fail(400, 'invalid_webhook');
  const event = verified as {
    type: unknown;
    timestamp?: unknown;
    data?: { id?: unknown; banned?: unknown };
  };
  if (typeof event.type !== 'string' || event.type.length > 128) fail(400, 'invalid_webhook');
  const nonce = random(16);
  const statements = [
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO webhooks(id,accepted_at,acceptance_id) VALUES(?,?,?)',
    ).bind(id, now(), nonce),
  ];
  if (event.type === 'user.deleted') {
    if (typeof event.data?.id !== 'string' || event.data.id.length > 256)
      fail(400, 'invalid_webhook');
    // The lifecycle statements themselves are idempotent. Acceptance and
    // revocation happen in a single transaction, not a fragile waitUntil task.
    statements.push(...disable(c.env, event.data.id, now(), { id, nonce }));
  }
  if (event.type === 'user.updated') {
    if (
      typeof event.data?.id !== 'string' ||
      event.data.id.length > 256 ||
      typeof event.data.banned !== 'boolean' ||
      typeof event.timestamp !== 'number' ||
      !Number.isSafeInteger(event.timestamp) ||
      event.timestamp < 0
    )
      fail(400, 'invalid_webhook');
    statements.push(
      ...eligibilityStatements(
        c.env,
        event.data.id,
        event.data.banned,
        event.timestamp,
        now(),
        true,
        { id, nonce },
      ),
    );
  }
  await c.env.DB.batch(statements);
  return c.body(null, 204);
});

export async function cleanup(env: Env, time = now()) {
  const cutoff = historyCutoff(time);
  // Each eligibility query uses an expiry/account index and a finite LIMIT.
  // Transactions detach pointers before R2 deletion. Repeated invocations make
  // forward progress rather than attempting a whole-database expiration sweep.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE documents SET blob_key=NULL,revision=revision+1 WHERE rowid IN
      (SELECT rowid FROM documents WHERE namespace='history' AND blob_key IS NOT NULL AND occurred_at<? ORDER BY occurred_at LIMIT 1000)`,
    ).bind(cutoff),
    env.DB.prepare(
      `UPDATE mutations SET response=NULL,blob_key=NULL,metadata_size=512 WHERE rowid IN
      (SELECT rowid FROM mutations WHERE namespace='history' AND (blob_key IS NOT NULL OR response IS NOT NULL) AND occurred_at<? ORDER BY occurred_at LIMIT 1000)`,
    ).bind(cutoff),
    env.DB.prepare(
      `UPDATE blobs SET state='deleting' WHERE key IN
      (SELECT key FROM blobs WHERE occurred_at IS NOT NULL AND occurred_at<? AND state<>'deleting' ORDER BY occurred_at LIMIT 1000)`,
    ).bind(cutoff),
    env.DB.prepare(
      `UPDATE blobs SET state='deleting' WHERE key IN
      (SELECT key FROM blobs WHERE state='pending' AND expires<=? ORDER BY expires LIMIT 1000)`,
    ).bind(time),
    env.DB.prepare(
      `UPDATE refresh_history SET successor=NULL WHERE hash IN
      (SELECT hash FROM refresh_history WHERE successor IS NOT NULL AND grace_until<=? ORDER BY grace_until LIMIT 1000)`,
    ).bind(time),
    env.DB.prepare(
      `DELETE FROM pairings WHERE id IN(SELECT id FROM pairings WHERE expires<=? ORDER BY expires LIMIT 1000)`,
    ).bind(time),
    env.DB.prepare(
      `DELETE FROM rate_limits WHERE key IN(SELECT key FROM rate_limits WHERE expires<=? ORDER BY expires LIMIT 1000)`,
    ).bind(time),
    env.DB.prepare(
      `DELETE FROM webhooks WHERE id IN(SELECT id FROM webhooks WHERE accepted_at<? ORDER BY accepted_at LIMIT 1000)`,
    ).bind(time - 365 * 86400000),
  ]);
  const expired = await env.DB.prepare(
    `SELECT id FROM(SELECT id FROM sessions WHERE idle_expires<=? ORDER BY idle_expires LIMIT 100)
    UNION SELECT id FROM(SELECT id FROM sessions WHERE absolute_expires<=? ORDER BY absolute_expires LIMIT 100)
    UNION SELECT id FROM(SELECT id FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at<? ORDER BY revoked_at LIMIT 100) LIMIT 100`,
  )
    .bind(time, time, time - 120000)
    .all<{ id: string }>();
  await removeSessions(
    env,
    expired.results.map((row) => row.id),
  );
  const revocations = await env.DB.prepare(
    'SELECT id,session_epoch FROM accounts WHERE revocation_pending=1 ORDER BY id LIMIT 10',
  ).all<{ id: string; session_epoch: number }>();
  for (const account of revocations.results)
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sessions SET revoked_at=? WHERE id IN(SELECT id FROM sessions WHERE account_id=? AND account_epoch<>? AND revoked_at IS NULL LIMIT 1000)`,
      ).bind(time, account.id, account.session_epoch),
      env.DB.prepare(
        `UPDATE accounts SET revocation_pending=0 WHERE id=? AND NOT EXISTS(SELECT 1 FROM sessions WHERE account_id=accounts.id AND account_epoch<>accounts.session_epoch AND revoked_at IS NULL)`,
      ).bind(account.id),
    ]);
  // Bounded work per invocation. Bulk D1/R2 calls stay below D1's 1,000
  // queries/invocation and 100 bound parameters/query limits. State is durable,
  // so any R2 failure is safely retryable.
  const deleted = await env.DB.prepare(
    `SELECT id FROM accounts WHERE deleted_at IS NOT NULL AND cleanup_pending=1 ORDER BY deleted_at,id LIMIT 10`,
  ).all<{ id: string }>();
  for (const account of deleted.results) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM mutations WHERE rowid IN(SELECT rowid FROM mutations WHERE account_id=? LIMIT 1000)`,
      ).bind(account.id),
      env.DB.prepare(
        `DELETE FROM documents WHERE rowid IN(SELECT rowid FROM documents WHERE account_id=? LIMIT 1000)`,
      ).bind(account.id),
      env.DB.prepare(
        `DELETE FROM pairings WHERE id IN(SELECT id FROM pairings WHERE account_id=? LIMIT 1000)`,
      ).bind(account.id),
      env.DB.prepare(
        `UPDATE blobs SET state='deleting' WHERE key IN(SELECT key FROM blobs WHERE account_id=? AND state<>'deleting' LIMIT 1000)`,
      ).bind(account.id),
    ]);
    const owned = await env.DB.prepare('SELECT id FROM sessions WHERE account_id=? LIMIT 100')
      .bind(account.id)
      .all<{ id: string }>();
    await removeSessions(
      env,
      owned.results.map((row) => row.id),
    );
    await env.DB.prepare(
      `UPDATE accounts SET cleanup_pending=0 WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM mutations WHERE account_id=accounts.id) AND NOT EXISTS(SELECT 1 FROM documents WHERE account_id=accounts.id)
      AND NOT EXISTS(SELECT 1 FROM pairings WHERE account_id=accounts.id) AND NOT EXISTS(SELECT 1 FROM sessions WHERE account_id=accounts.id)
      AND NOT EXISTS(SELECT 1 FROM blobs WHERE account_id=accounts.id AND state<>'deleting')`,
    )
      .bind(account.id)
      .run();
  }
  const doomed = await env.DB.prepare(
    `SELECT b.key FROM(SELECT key FROM blobs WHERE state='deleting' ORDER BY expires,key LIMIT 10000) b
    WHERE NOT EXISTS(SELECT 1 FROM documents WHERE blob_key=b.key) AND NOT EXISTS(SELECT 1 FROM mutations WHERE blob_key=b.key)`,
  ).all<{ key: string }>();
  for (let offset = 0; offset < doomed.results.length; offset += 1000) {
    const keys = doomed.results.slice(offset, offset + 1000).map((b) => b.key);
    await env.BLOBS.delete(keys);
    for (let index = 0; index < keys.length; index += 100) {
      const chunk = keys.slice(index, index + 100);
      await env.DB.prepare(
        `DELETE FROM blobs WHERE key IN(${chunk.map(() => '?').join(',')}) AND state='deleting'
        AND NOT EXISTS(SELECT 1 FROM documents WHERE blob_key=blobs.key) AND NOT EXISTS(SELECT 1 FROM mutations WHERE blob_key=blobs.key)`,
      )
        .bind(...chunk)
        .run();
    }
  }
  // A request might complete an R2 upload after its pending row was abandoned
  // or its account was deleted. Inventory catches even these late orphan puts.
  const state = await env.DB.prepare("SELECT cursor FROM cleanup_state WHERE id='r2'").first<{
    cursor: string | null;
  }>();
  let cursor = state?.cursor;
  for (let sweep = 0; sweep < 20; sweep++) {
    const page = await env.BLOBS.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    const old = page.objects.filter((object) => object.uploaded.getTime() <= time - 86400000),
      orphans: string[] = [];
    for (let index = 0; index < old.length; index += 100) {
      const keys = old.slice(index, index + 100).map((o) => o.key);
      const rows = await env.DB.prepare(
        `SELECT key,state FROM blobs WHERE key IN(${keys.map(() => '?').join(',')})`,
      )
        .bind(...keys)
        .all<{ key: string; state: string }>();
      const live = new Set(rows.results.filter((r) => r.state !== 'deleting').map((r) => r.key));
      orphans.push(...keys.filter((k) => !live.has(k)));
    }
    if (orphans.length) await env.BLOBS.delete(orphans);
    cursor = page.truncated ? page.cursor : null;
    await env.DB.prepare(
      "INSERT INTO cleanup_state(id,cursor) VALUES('r2',?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor",
    )
      .bind(cursor)
      .run();
    if (!page.truncated) break;
  }
}

async function removeSessions(env: Env, ids: string[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM refresh_history WHERE hash IN(SELECT hash FROM refresh_history WHERE session_id IN(${placeholders}) LIMIT 1000)`,
    ).bind(...ids),
    env.DB.prepare(
      `DELETE FROM sessions WHERE id IN(${placeholders}) AND NOT EXISTS(SELECT 1 FROM refresh_history WHERE session_id=sessions.id)`,
    ).bind(...ids),
  ]);
}
