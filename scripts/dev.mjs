import { spawn } from 'node:child_process';

const children = [
  spawn('corepack', ['pnpm', 'exec', 'wrangler', 'dev', '--local', '--port', '8787'], { stdio: 'inherit' }),
  spawn('corepack', ['pnpm', '--filter', '@finance-tools/web', 'dev'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
