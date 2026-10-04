import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const account = '01234567'.repeat(4);
const database = ['01234567', '89ab', 'cdef', '0123', '456789abcdef'].join('-');
const token = 'synthetic-token-for-redaction';

it.each(['success', 'failure', 'signal'])(
  'redacts split output and sequences deployment: %s',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'finance-deploy-wrapper-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'node_modules/wrangler/bin'), { recursive: true });
      writeFileSync(
        join(root, 'scripts/deploy-cloudflare.mjs'),
        readFileSync(new URL('./deploy-cloudflare.mjs', import.meta.url)),
      );
      writeFileSync(join(root, 'scripts/deploy-preflight.mjs'), "console.log('preflight passed');");
      writeFileSync(
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        `
      const fs = require('node:fs');
      fs.appendFileSync('calls.jsonl', JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');
      (async () => {
        for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']) {
          const value = process.env[name].toUpperCase();
          for (const stream of [process.stdout, process.stderr]) {
            stream.write('useful prefix ' + value.slice(0, 7));
            await new Promise(resolve => setTimeout(resolve, 15));
            stream.write(value.slice(7) + ' useful suffix\\n');
          }
        }
        if (process.argv[2] === 'd1' && process.env.TEST_MODE === 'failure') process.exitCode = 7;
        if (process.argv[2] === 'd1' && process.env.TEST_MODE === 'signal') process.kill(process.pid, 'SIGTERM');
      })();
    `,
      );
      const result = spawnSync(process.execPath, [join(root, 'scripts/deploy-cloudflare.mjs')], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          WRANGLER_SEND_METRICS: 'false',
          WORKERS_CI: '1',
          WORKERS_CI_BRANCH: 'main',
          CLOUDFLARE_ACCOUNT_ID: account,
          CLOUDFLARE_D1_DATABASE_ID: database,
          CLOUDFLARE_API_TOKEN: token,
          TEST_MODE: mode,
        },
      });
      const output = result.stdout + result.stderr;
      for (const value of [account, database, token])
        expect(output.toLowerCase()).not.toContain(value.toLowerCase());
      expect(output).toContain('useful prefix [REDACTED] useful suffix');
      expect(result.status).toBe(mode === 'success' ? 0 : mode === 'failure' ? 7 : 143);
      const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.args)).toEqual(
        mode === 'success'
          ? [
              [
                'd1',
                'migrations',
                'apply',
                'finance-tools',
                '--remote',
                '--config',
                'wrangler.deploy.jsonc',
              ],
              ['deploy', '--config', 'wrangler.deploy.jsonc'],
            ]
          : [
              [
                'd1',
                'migrations',
                'apply',
                'finance-tools',
                '--remote',
                '--config',
                'wrangler.deploy.jsonc',
              ],
            ],
      );
      for (const call of calls) {
        expect(call.env.CLOUDFLARE_API_TOKEN).toBe(token);
        expect(call.env.CF_API_TOKEN).toBeUndefined();
        expect(call.env.CLOUDFLARE_API_KEY).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
