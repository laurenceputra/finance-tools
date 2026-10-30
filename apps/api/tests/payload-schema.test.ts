import { expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { migrate } from './migrations';

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
