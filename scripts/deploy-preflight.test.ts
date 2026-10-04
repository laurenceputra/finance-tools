import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';

const account = '01234567'.repeat(4);
const database = ['01234567', '89ab', 'cdef', '0123', '456789abcdef'].join('-');
const token = 'simulated-not-a-secret';
const directories: string[] = [];
function isolatedEnv(root: string) {
  return {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: root,
    TMPDIR: root,
    WRANGLER_SEND_METRICS: 'false',
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it('does not inherit parent authentication or Wrangler settings in fixture environments', () => {
  for (const name of [
    'CF_API_TOKEN',
    'CF_API_KEY',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'WRANGLER_LOG_PATH',
    'NODE_OPTIONS',
  ])
    vi.stubEnv(name, 'parent-credential-sentinel');
  expect(Object.values(isolatedEnv('/synthetic/home'))).not.toContain('parent-credential-sentinel');
  expect(run().status).toBe(0);
});
function run(
  overrides: Record<string, string> = {},
  configOverrides: Record<string, unknown> = {},
  rawConfig?: string,
  trackedLeak?: string,
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
    join(root, 'scripts/deploy-preflight.mjs'),
    readFileSync(new URL('./deploy-preflight.mjs', import.meta.url)),
  );
  const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    rawConfig ?? JSON.stringify({ ...parse(template), ...configOverrides }),
  );
  const env = isolatedEnv(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root, env });
  execFileSync('git', ['add', 'wrangler.jsonc', 'scripts'], { cwd: root, env });
  if (trackedLeak) {
    writeFileSync(join(root, 'leak.txt'), trackedLeak);
    execFileSync('git', ['add', 'leak.txt'], { cwd: root, env });
  }
  writeFileSync(join(root, 'wrangler.deploy.jsonc'), 'stale');
  const result = spawnSync(process.execPath, [join(root, 'scripts/deploy-preflight.mjs')], {
    encoding: 'utf8',
    env: {
      ...env,
      WORKERS_CI: '1',
      WORKERS_CI_BRANCH: 'main',
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_D1_DATABASE_ID: database,
      ...overrides,
    },
  });
  expect(result.stdout + result.stderr).not.toContain(token);
  expect(result.stdout + result.stderr).not.toContain(account);
  expect(result.stdout + result.stderr).not.toContain(database);
  expect(existsSync(join(root, 'wrangler.deploy.jsonc.tmp'))).toBe(false);
  if (result.status !== 0) expect(existsSync(join(root, 'wrangler.deploy.jsonc'))).toBe(false);
  return { ...result, root };
}
it('injects synthetic identifiers into the actual template without changing bindings or paths', () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const generated = JSON.parse(readFileSync(join(result.root, 'wrangler.deploy.jsonc'), 'utf8'));
  const template = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  expect(generated).toEqual({
    ...template,
    account_id: account,
    d1_databases: template.d1_databases.map((binding: object) => ({
      ...binding,
      database_id: database,
    })),
  });
  expect(statSync(join(result.root, 'wrangler.deploy.jsonc')).mode & 0o777).toBe(0o600);
});
it('requires main Workers Builds and rejects missing or malformed deployment variables', () => {
  for (const overrides of [
    { WORKERS_CI: '' },
    { WORKERS_CI: 'true' },
    { WORKERS_CI_BRANCH: '' },
    { WORKERS_CI_BRANCH: 'feature' },
    { CLOUDFLARE_API_TOKEN: '' },
    { CLOUDFLARE_ACCOUNT_ID: '' },
    { CLOUDFLARE_ACCOUNT_ID: 'invalid' },
    { CLOUDFLARE_D1_DATABASE_ID: '' },
    { CLOUDFLARE_D1_DATABASE_ID: 'invalid' },
  ])
    expect(run(overrides).status).not.toBe(0);
});
it('fails closed on malformed JSONC, embedded identifiers and previews', () => {
  expect(run({}, {}, '{ "workers_dev": false, broken }').status).not.toBe(0);
  for (const config of [
    { account_id: account },
    { workers_dev: true },
    { preview_urls: true },
    { d1_databases: [{ binding: 'DB', database_id: database }] },
  ])
    expect(run({}, config).status).not.toBe(0);
  expect(run({}, {}, undefined, account).status).not.toBe(0);
  expect(run({}, {}, undefined, database).status).not.toBe(0);
});
it('keeps deployment configs ignored and both remote commands on the generated config', () => {
  const root = new URL('../', import.meta.url).pathname;
  for (const file of ['wrangler.deploy.jsonc', 'wrangler.deploy.jsonc.tmp'])
    expect(
      execFileSync('git', ['check-ignore', file], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe(file);
  const command = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    .scripts['deploy:cloudflare'];
  expect(command).toBe('node scripts/deploy-cloudflare.mjs');
});
it('bundles the generated configuration with Wrangler dry-run without remote operations', () => {
  const result = run();
  expect(result.status).toBe(0);
  for (const directory of ['apps']) {
    symlinkSync(
      new URL(`../${directory}`, import.meta.url).pathname,
      join(result.root, directory),
      'dir',
    );
  }
  mkdirSync(join(result.root, 'dist'));
  writeFileSync(
    join(result.root, 'dist/index.html'),
    '<!doctype html><title>synthetic fixture</title>',
  );
  const dryRun = spawnSync(
    new URL('../node_modules/.bin/wrangler', import.meta.url).pathname,
    ['deploy', '--dry-run', '--config', join(result.root, 'wrangler.deploy.jsonc')],
    {
      cwd: result.root,
      encoding: 'utf8',
      env: {
        ...isolatedEnv(result.root),
      },
    },
  );
  expect(dryRun.status).toBe(0);
  expect(dryRun.stdout).toContain('--dry-run: exiting now.');
}, 30000);
