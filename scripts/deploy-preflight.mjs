import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../wrangler.deploy.jsonc', import.meta.url);
const temporary = new URL('../wrangler.deploy.jsonc.tmp', import.meta.url);
try {
  // Never reuse a previous build's deployment configuration.
  rmSync(output, { force: true });
  rmSync(temporary, { force: true });
  if (process.env.WORKERS_CI !== '1' || process.env.WORKERS_CI_BRANCH !== 'main') {
    throw new Error(
      'Cloudflare Workers Builds on main is required (WORKERS_CI=1, WORKERS_CI_BRANCH=main).',
    );
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const database = process.env.CLOUDFLARE_D1_DATABASE_ID ?? '';
  if (!/^[0-9a-f]{32}$/i.test(account))
    throw new Error('Invalid or missing CLOUDFLARE_ACCOUNT_ID.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(database)) {
    throw new Error('Invalid or missing CLOUDFLARE_D1_DATABASE_ID.');
  }
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim())
    throw new Error('Cloudflare Builds deployment credentials are required.');
  const errors = [];
  const config = parse(
    readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('invalid Wrangler JSONC configuration.');
  }
  const binding = config.d1_databases?.find((entry) => entry.binding === 'DB');
  if ('account_id' in config || binding?.database_id !== 'REPLACE_WITH_PROVISIONED_D1_ID') {
    throw new Error('Tracked Wrangler configuration must contain only provisioning placeholders.');
  }
  if (config.workers_dev !== false || config.preview_urls !== false) {
    throw new Error('workers.dev and preview URLs must remain disabled.');
  }
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    const contents = readFileSync(
      new URL(file, new URL('../', import.meta.url)),
      'utf8',
    ).toLowerCase();
    if (contents.includes(account.toLowerCase()) || contents.includes(database.toLowerCase())) {
      throw new Error('Deployment identifiers must not appear in tracked files.');
    }
  }
  config.account_id = account;
  binding.database_id = database;
  // Root placement preserves all template-relative entrypoint, asset and migration paths.
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, output);
} catch (error) {
  rmSync(temporary, { force: true });
  console.error(
    `Deployment blocked: ${error instanceof Error && !('code' in error) ? error.message : 'Unable to prepare deployment configuration.'}`,
  );
  process.exitCode = 1;
}
