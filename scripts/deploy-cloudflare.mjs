import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const values = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']
  .map((name) => process.env[name])
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);

function redactStream(destination) {
  let pending = '';
  const longest = Math.max(1, ...values.map((value) => value.length));
  function drain(final = false) {
    let output = '';
    while (pending.length && (final || pending.length >= longest)) {
      const match = values.find(
        (value) => pending.slice(0, value.length).toLowerCase() === value.toLowerCase(),
      );
      if (match) {
        output += '[REDACTED]';
        pending = pending.slice(match.length);
      } else {
        output += pending[0];
        pending = pending.slice(1);
      }
    }
    if (output) destination.write(output);
  }
  return {
    write(chunk) {
      pending += chunk;
      drain();
    },
    end() {
      drain(true);
    },
  };
}

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
    const stdout = redactStream(process.stdout);
    const stderr = redactStream(process.stderr);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    active = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', stdout.write);
    child.stderr.on('data', stderr.write);
    child.on('error', () => stderr.write('Deployment blocked: unable to start deployment tool.\n'));
    child.on('close', (code, signal) => {
      stdout.end();
      stderr.end();
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
}
