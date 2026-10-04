import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function run(
  overrides: Record<string, string> = {},
  configOverrides: Record<string, unknown> = {},
  rawConfig?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'finance-preflight-'));
  directories.push(root);
  mkdirSync(join(root, 'scripts'));
  symlinkSync(
    new URL('../node_modules', import.meta.url).pathname,
    join(root, 'node_modules'),
    'dir',
  );
  writeFileSync(
    join(root, 'scripts', 'deploy-preflight.mjs'),
    readFileSync(new URL('./deploy-preflight.mjs', import.meta.url)),
  );
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    rawConfig ??
      JSON.stringify({
        workers_dev: false,
        preview_urls: false,
        d1_databases: [{ binding: 'DB', database_id: '01234567-89ab-cdef-0123-456789abcdef' }],
        ...configOverrides,
      }),
  );
  return spawnSync(process.execPath, [join(root, 'scripts', 'deploy-preflight.mjs')], {
    encoding: 'utf8',
    env: {
      WORKERS_CI: '1',
      WORKERS_CI_BRANCH: 'main',
      CLOUDFLARE_API_TOKEN: 'simulated-not-a-secret',
      CLOUDFLARE_ACCOUNT_ID: 'simulated-account',
      ...overrides,
    },
  });
}
it('accepts only main Workers Builds with provisioned configuration and credentials', () => {
  expect(run().status).toBe(0);
  for (const overrides of [
    { WORKERS_CI: '' },
    { WORKERS_CI: 'true' },
    { WORKERS_CI_BRANCH: '' },
    { WORKERS_CI_BRANCH: 'feature' },
  ]) {
    const result = run(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Cloudflare Workers Builds on main is required');
  }
  expect(run({ WORKERS_CI: '', WORKERS_CI_BRANCH: '', CF_PAGES_BRANCH: 'main' }).status).not.toBe(
    0,
  );
});
it('fails closed on malformed JSONC rather than accepting a partial parse', () => {
  const result = run({}, {}, '{ "workers_dev": false, broken }');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('invalid Wrangler JSONC configuration');
});
it('accepts the actual checked-in JSONC with provisioned D1 under simulated Builds credentials', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('./deploy-preflight.mjs', import.meta.url).pathname],
    {
      encoding: 'utf8',
      env: {
        WORKERS_CI: '1',
        WORKERS_CI_BRANCH: 'main',
        CLOUDFLARE_API_TOKEN: 'simulated-not-a-secret',
        CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000000',
      },
    },
  );
  expect(result.stderr).not.toContain('SyntaxError');
  expect(result.status, result.stderr).toBe(0);
});
it('blocks placeholders, preview URLs and missing credentials without printing tokens', () => {
  for (const config of [
    { d1_databases: [{ binding: 'DB', database_id: 'REPLACE_WITH_PROVISIONED_D1_ID' }] },
    { workers_dev: true },
    { preview_urls: true },
  ])
    expect(run({}, config).status).not.toBe(0);
  for (const env of [{ CLOUDFLARE_API_TOKEN: '' }, { CLOUDFLARE_ACCOUNT_ID: '' }])
    expect(run(env).status).not.toBe(0);
  expect(run({ WORKERS_CI_BRANCH: 'feature' }).stderr).not.toContain('simulated-not-a-secret');
});
