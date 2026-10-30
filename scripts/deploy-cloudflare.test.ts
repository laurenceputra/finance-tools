import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each(['success', 'failure', 'signal', 'preflight-failure', 'native-auth'])(
  'sequences deployment and preserves Wrangler output/auth: %s',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'finance-deploy-wrapper-'));
    const token = 'synthetic-native-builds-token';
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'node_modules/wrangler/bin'), { recursive: true });
      symlinkSync(
        new URL('../node_modules/jsonc-parser', import.meta.url).pathname,
        join(root, 'node_modules/jsonc-parser'),
        'dir',
      );
      for (const script of [
        'deploy-cloudflare.mjs',
        'deploy-preflight.mjs',
        'deployment-config.mjs',
      ])
        writeFileSync(
          join(root, 'scripts', script),
          readFileSync(new URL(`./${script}`, import.meta.url)),
        );
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        readFileSync(new URL('../wrangler.jsonc', import.meta.url)),
      );
      writeFileSync(
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        `
      const fs = require('node:fs');
      fs.appendFileSync('calls.jsonl', JSON.stringify({ args: process.argv.slice(2), token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, config: JSON.parse(fs.readFileSync('wrangler.deploy.jsonc', 'utf8')) }) + '\\n');
      console.log('Wrangler normal output');
      console.error('Wrangler normal diagnostic');
      if (process.argv[2] === 'd1' && process.env.TEST_MODE === 'failure') process.exitCode = 7;
      if (process.argv[2] === 'd1' && process.env.TEST_MODE === 'signal') process.kill(process.pid, 'SIGTERM');
    `,
      );
      const result = spawnSync(process.execPath, [join(root, 'scripts/deploy-cloudflare.mjs')], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          WORKERS_CI: '1',
          WORKERS_CI_BRANCH: mode === 'preflight-failure' ? 'feature' : 'main',
          APP_HOSTNAME: 'finance.example.com',
          CLOUDFLARE_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
          ...(mode === 'native-auth' ? {} : { CLOUDFLARE_API_TOKEN: token }),
          TEST_MODE: mode,
        },
      });
      expect(result.stdout + result.stderr).not.toContain(token);
      expect(existsSync(join(root, 'wrangler.deploy.jsonc'))).toBe(false);
      expect(result.status).toBe(
        mode === 'failure' ? 7 : mode === 'signal' ? 143 : mode === 'preflight-failure' ? 1 : 0,
      );
      if (mode === 'preflight-failure') {
        expect(existsSync(join(root, 'calls.jsonl'))).toBe(false);
        expect(result.stderr).toContain('Deployment blocked');
        return;
      }
      expect(result.stdout).toContain('Wrangler normal output');
      expect(result.stderr).toContain('Wrangler normal diagnostic');
      const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const migrations = [
        'd1',
        'migrations',
        'apply',
        'finance-tools',
        '--remote',
        '--config',
        'wrangler.deploy.jsonc',
      ];
      expect(calls.map((call) => call.args)).toEqual(
        mode === 'failure' || mode === 'signal'
          ? [migrations]
          : [migrations, ['deploy', '--config', 'wrangler.deploy.jsonc']],
      );
      for (const call of calls) {
        expect(call.token).toBe(mode === 'native-auth' ? undefined : token);
        expect(call.account).toBeUndefined();
        expect(call.config.d1_databases[0].database_id).toBe(
          '11111111-1111-4111-8111-111111111111',
        );
        expect(call.config.vars.APP_ORIGIN).toBe('https://finance.example.com');
      }
      if (calls.length === 2) expect(calls[0].config).toEqual(calls[1].config);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
