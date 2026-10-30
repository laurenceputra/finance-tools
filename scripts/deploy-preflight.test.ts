import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';

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
  for (const script of ['deploy-preflight.mjs', 'deployment-config.mjs'])
    writeFileSync(
      join(root, 'scripts', script),
      readFileSync(new URL(`./${script}`, import.meta.url)),
    );
  const template = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = rawConfig ?? JSON.stringify({ ...parse(template), ...configOverrides });
  writeFileSync(join(root, 'wrangler.jsonc'), config);
  writeFileSync(join(root, 'wrangler.deploy.jsonc'), 'stale private output');
  const result = spawnSync(process.execPath, [join(root, 'scripts/deploy-preflight.mjs')], {
    encoding: 'utf8',
    env: {
      ...isolatedEnv(root),
      WORKERS_CI: '1',
      WORKERS_CI_BRANCH: 'main',
      APP_HOSTNAME: 'finance.example.com',
      CLOUDFLARE_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
      ...overrides,
    },
  });
  expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(config);
  expect(existsSync(join(root, 'wrangler.deploy.jsonc'))).toBe(result.status === 0);
  expect(readdirSync(root).filter((name) => name.startsWith('.wrangler-deploy-'))).toEqual([]);
  return { ...result, root };
}
it('generates private root-relative configuration without custom authentication variables or git', () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(run({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' }).status).toBe(0);
  const output = join(result.root, 'wrangler.deploy.jsonc');
  expect(statSync(output).mode & 0o777).toBe(0o600);
  const config = JSON.parse(readFileSync(output, 'utf8'));
  expect(config.d1_databases[0].database_id).toBe('11111111-1111-4111-8111-111111111111');
  expect(config.routes).toEqual([{ pattern: 'finance.example.com', custom_domain: true }]);
  expect(config.vars.APP_ORIGIN).toBe('https://finance.example.com');
  expect(config.main).toBe('apps/api/src/index.ts');
  expect(config.assets.directory).toBe('dist');
  expect(config.d1_databases[0].migrations_dir).toBe('apps/api/migrations');
});
it('rejects missing/invalid UUIDs and hostname protocols, ports, paths or injection without echoing values', () => {
  for (const value of [
    '',
    'invalid',
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111\n',
  ]) {
    expect(run({ CLOUDFLARE_D1_DATABASE_ID: value }).status).not.toBe(0);
  }
  for (const value of [
    '',
    'https://finance.example.com',
    'finance.example.com:443',
    'finance.example.com/path',
    'finance.example.com?x=1',
    'finance.example.com#x',
    'user@finance.example.com',
    '*.example.com',
    'finance..example.com',
    '-finance.example.com',
    'finance.example.com.',
    'finance.example.com\n',
    'finance.example.com"',
    '127.0.0.1',
    'finance.123',
    'finance.0x123',
  ]) {
    const result = run({ APP_HOSTNAME: value });
    expect(result.status).not.toBe(0);
    if (value) expect(result.stderr).not.toContain(value);
  }
  const result = run({ APP_HOSTNAME: 'Finance.Example.COM' });
  expect(
    JSON.parse(readFileSync(join(result.root, 'wrangler.deploy.jsonc'), 'utf8')).vars.APP_ORIGIN,
  ).toBe('https://finance.example.com');
});
it('requires main Workers Builds before deployment', () => {
  for (const overrides of [
    { WORKERS_CI: '' },
    { WORKERS_CI: 'true' },
    { WORKERS_CI_BRANCH: '' },
    { WORKERS_CI_BRANCH: 'feature' },
  ])
    expect(run(overrides).status).not.toBe(0);
});
it('fails closed on malformed JSONC, missing/invalid DB UUIDs and previews', () => {
  for (const raw of ['{ "workers_dev": false, broken }', 'null', '[]'])
    expect(run({}, {}, raw).status).not.toBe(0);
  for (const config of [
    { workers_dev: true },
    { preview_urls: true },
    { workers_dev: undefined },
    { preview_urls: undefined },
    { d1_databases: null },
    { d1_databases: {} },
    { d1_databases: [] },
    { d1_databases: [{ binding: 'NOT_DB' }] },
  ])
    expect(run({}, config).status).not.toBe(0);
});
it('bundles generated configuration with a local-only Wrangler dry-run without Builds flags or auth', () => {
  const result = run();
  expect(result.status).toBe(0);
  symlinkSync(new URL('../apps', import.meta.url).pathname, join(result.root, 'apps'), 'dir');
  mkdirSync(join(result.root, 'dist'));
  writeFileSync(
    join(result.root, 'dist/index.html'),
    '<!doctype html><title>synthetic fixture</title>',
  );
  const dryRun = spawnSync(
    new URL('../node_modules/.bin/wrangler', import.meta.url).pathname,
    ['deploy', '--dry-run', '--config', join(result.root, 'wrangler.deploy.jsonc')],
    { cwd: result.root, encoding: 'utf8', env: isolatedEnv(result.root) },
  );
  expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(0);
  expect(dryRun.stdout).toContain('--dry-run: exiting now.');
}, 30000);
