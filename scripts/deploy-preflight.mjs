import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';

if (process.env.WORKERS_CI !== '1' || process.env.WORKERS_CI_BRANCH !== 'main') {
  throw new Error(
    'Deployment blocked: Cloudflare Workers Builds on main is required (WORKERS_CI=1, WORKERS_CI_BRANCH=main).',
  );
}
const errors = [];
const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), errors, {
  allowTrailingComma: true,
});
if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('Deployment blocked: invalid Wrangler JSONC configuration.');
}
const databaseId = config.d1_databases?.find((binding) => binding.binding === 'DB')?.database_id;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId ?? '')) {
  throw new Error(
    'Deployment blocked: replace the D1 provisioning placeholder with the real database UUID.',
  );
}
if (config.workers_dev !== false || config.preview_urls !== false) {
  throw new Error('Deployment blocked: workers.dev and preview URLs must remain disabled.');
}
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error('Deployment blocked: Cloudflare Builds deployment credentials are required.');
}
