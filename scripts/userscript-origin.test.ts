import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('builds userscript network permissions, updates, API and pairing URLs from configured hostname', () => {
  const root = mkdtempSync(join(tmpdir(), 'finance-script-origin-'));
  try {
    mkdirSync(join(root, 'apps/userscripts'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    for (const name of ['node_modules', 'packages'])
      symlinkSync(new URL(`../${name}`, import.meta.url).pathname, join(root, name), 'dir');
    symlinkSync(
      new URL('../apps/userscripts/src', import.meta.url).pathname,
      join(root, 'apps/userscripts/src'),
      'dir',
    );
    writeFileSync(
      join(root, 'apps/userscripts/build.mjs'),
      readFileSync(new URL('../apps/userscripts/build.mjs', import.meta.url)),
    );
    writeFileSync(
      join(root, 'scripts/deployment-config.mjs'),
      readFileSync(new URL('./deployment-config.mjs', import.meta.url)),
    );
    const build = (hostname?: string) =>
      spawnSync(process.execPath, ['build.mjs'], {
        cwd: join(root, 'apps/userscripts'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          WORKERS_CI: '1',
          ...(hostname === undefined ? {} : { APP_HOSTNAME: hostname }),
        },
      });
    expect(build().status).not.toBe(0);
    const result = build('custom.example.com');
    expect(result.status, result.stderr).toBe(0);
    for (const name of ['portfolio', 'bank-subcaps']) {
      const script = readFileSync(join(root, `dist/scripts/${name}.user.js`), 'utf8');
      expect(script).toContain('// @connect custom.example.com\n');
      expect(script).toContain(
        `// @downloadURL https://custom.example.com/scripts/${name}.user.js`,
      );
      expect(script).toContain(`// @updateURL https://custom.example.com/scripts/${name}.user.js`);
      expect(script).toContain('APP_ORIGIN = "https://custom.example.com"');
      expect(script).toContain('`${APP_ORIGIN}/api/v1`');
      expect(script).toContain('`${APP_ORIGIN}/?pairingId=');
      expect(script).not.toContain('https://finance.example.com/api');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
