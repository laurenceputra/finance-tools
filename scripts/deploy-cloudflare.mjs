import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
let active;
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = signal;
    active?.kill(signal);
  });
}
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    active = child;
    child.on('error', () => console.error('Deployment blocked: unable to start deployment tool.'));
    child.on('close', (code, signal) => {
      active = undefined;
      resolve({ code: code ?? 1, signal: signal ?? interrupted });
    });
  });
}

try {
  const wrangler = fileURLToPath(
    new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
  );
  const commands = [
    [fileURLToPath(new URL('./deploy-preflight.mjs', import.meta.url))],
    [
      wrangler,
      'd1',
      'migrations',
      'apply',
      'finance-tools',
      '--remote',
      '--config',
      'wrangler.deploy.jsonc',
    ],
    [wrangler, 'deploy', '--config', 'wrangler.deploy.jsonc'],
  ];
  for (const args of commands) {
    const result = await run(args);
    if (result.signal) {
      // Use conventional signal exit codes without starting subsequent commands.
      process.exitCode = result.signal === 'SIGINT' ? 130 : 143;
      break;
    }
    if (result.code !== 0 || interrupted) {
      process.exitCode = result.code || 1;
      break;
    }
  }
} catch {
  console.error('Deployment blocked: unable to orchestrate deployment.');
  process.exitCode = 1;
} finally {
  rmSync(new URL('../wrangler.deploy.jsonc', import.meta.url), { force: true });
}
