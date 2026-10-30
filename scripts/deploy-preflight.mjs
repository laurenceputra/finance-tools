import { readFileSync, writeFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { appHostname } from './deployment-config.mjs';

const output = new URL('../wrangler.deploy.jsonc', import.meta.url);
let temporary;
try {
  // Remove stale private output even when validation fails.
  rmSync(output, { force: true });
  if (process.env.WORKERS_CI !== '1' || process.env.WORKERS_CI_BRANCH !== 'main') {
    throw new Error(
      'Cloudflare Workers Builds on main is required (WORKERS_CI=1, WORKERS_CI_BRANCH=main).',
    );
  }
  const hostname = appHostname(process.env.APP_HOSTNAME);
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  if (
    typeof databaseId !== 'string' ||
    databaseId.trim() !== databaseId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId) ||
    databaseId === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new Error('CLOUDFLARE_D1_DATABASE_ID must be the existing D1 database UUID.');
  }
  const errors = [];
  const config = parse(
    readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid Wrangler JSONC template.');
  }
  if (
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    !Array.isArray(config.d1_databases) ||
    config.d1_databases.length !== 1 ||
    config.d1_databases[0]?.binding !== 'DB'
  ) {
    throw new Error('Template must contain one DB binding and disable workers.dev and previews.');
  }
  config.d1_databases[0].database_id = databaseId;
  config.routes = [{ pattern: hostname, custom_domain: true }];
  config.vars = { ...config.vars, APP_ORIGIN: `https://${hostname}` };
  // Same-directory rename is atomic; the private directory/file never allow other users access.
  temporary = mkdtempSync(fileURLToPath(new URL('../.wrangler-deploy-', import.meta.url)));
  const staged = join(temporary, 'config.jsonc');
  writeFileSync(staged, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(staged, output);
} catch (error) {
  rmSync(output, { force: true });
  console.error(
    `Deployment blocked: ${error instanceof Error && !('code' in error) ? error.message : 'Unable to prepare deployment configuration.'}`,
  );
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
