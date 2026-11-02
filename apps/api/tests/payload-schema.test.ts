import { expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { applyMigration, migrate } from './migrations';

it('requires an encrypted payload in the fresh schema and makes payload rows immutable', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch() {return new Response("test")}}',
    d1Databases: { DB: 'payload-schema' },
    compatibilityDate: '2025-10-04',
  });
  try {
    const db = await mf.getD1Database('DB');
    await migrate(db);
    await db
      .prepare("INSERT INTO accounts(id,subject,created_at) VALUES('account','user',0)")
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO blobs(key,account_id,bytes,created_at) VALUES('missing','account',2,0)",
        )
        .run(),
    ).rejects.toThrow('NOT NULL constraint failed');
    await expect(
      db
        .prepare(
          "INSERT INTO blobs(key,account_id,bytes,created_at,envelope) VALUES('null','account',2,0,NULL)",
        )
        .run(),
    ).rejects.toThrow('NOT NULL constraint failed');
    await db
      .prepare(
        "INSERT INTO blobs(key,account_id,bytes,created_at,envelope) VALUES('payload','account',2,0,'{}')",
      )
      .run();
    for (const assignment of ["envelope='changed'", 'bytes=3', "account_id='other'", "key='other'"])
      await expect(
        db.prepare(`UPDATE blobs SET ${assignment} WHERE key='payload'`).run(),
      ).rejects.toThrow('payload_immutable');
    expect((await db.prepare('SELECT key,envelope FROM blobs').all()).results).toEqual([
      { key: 'payload', envelope: '{}' },
    ]);
  } finally {
    await mf.dispose();
  }
});

it('additively caps existing millisecond session dates without extending expired sessions or converting legacy Private vaults', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch() {return new Response("test")}}',
    d1Databases: { DB: 'migration' },
    compatibilityDate: '2025-10-04',
  });
  try {
    const db = await mf.getD1Database('DB');
    await applyMigration(db, '0001_initial.sql');
    const start = Date.now() - 100 * 86400000;
    await db
      .prepare(
        "INSERT INTO accounts(id,subject,created_at,vault) VALUES('account','subject',?,'{\"version\":1}')",
      )
      .bind(start)
      .run();
    await db
      .prepare(
        "INSERT INTO sessions(id,account_id,client,created_at,last_used_at,idle_expires,absolute_expires,refresh_hash) VALUES('old','account','{}',?,?,?,?,'hash')",
      )
      .bind(start, start + 80 * 86400000, start + 170 * 86400000, start + 365 * 86400000)
      .run();
    await applyMigration(db, '0002_vault_modes.sql');
    const session = await db
      .prepare("SELECT idle_expires,absolute_expires FROM sessions WHERE id='old'")
      .first<{ idle_expires: number; absolute_expires: number }>();
    expect(session!.absolute_expires).toBe(start + 90 * 86400000);
    expect(session!.idle_expires).toBe(start + 90 * 86400000);
    expect(session!.absolute_expires).toBeLessThan(Date.now());
    expect(
      await db.prepare("SELECT vault,server_vault_wrap FROM accounts WHERE id='account'").first(),
    ).toEqual({ vault: '{"version":1}', server_vault_wrap: null });
  } finally {
    await mf.dispose();
  }
});
