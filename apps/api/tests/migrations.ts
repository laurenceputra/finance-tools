import { readdir, readFile } from 'node:fs/promises';

export async function migrate(db: D1Database) {
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    await applyMigration(db, name);
  }
}

export async function applyMigration(db: D1Database, name: string) {
  const migration = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
  // D1.exec splits lines; preserve complete multiline trigger bodies.
  const [tables, ...triggers] = migration.replace(/--[^\n]*/g, '').split('CREATE TRIGGER');
  await db.batch(
    tables
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  for (const trigger of triggers) await db.prepare('CREATE TRIGGER' + trigger).run();
}
