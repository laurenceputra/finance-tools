import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
for (const name of ['portfolio', 'bank-subcaps']) {
  const path = join(root, 'dist', 'scripts', `${name}.user.js`);
  const contents = readFileSync(path, 'utf8');
  const header = contents.split('// ==/UserScript==')[0];
  if (
    !contents.startsWith('// ==UserScript==') ||
    !contents.includes('// ==/UserScript==') ||
    !header.includes(`// @name Finance ${name}\n`) ||
    !header.includes(`// @version ${version}\n`) ||
    !header.includes(`// @downloadURL https://finance.laurenceputra.com/scripts/${name}.user.js`)
  ) {
    throw new Error(`Invalid userscript metadata: ${name}`);
  }
  if (statSync(path).size > 2 * 1024 * 1024)
    throw new Error(`Userscript exceeds 2 MiB budget: ${name}`);
}
// Public scripts must revalidate for updates. They contain no authenticated data.
writeFileSync(
  join(root, 'dist', '_headers'),
  '/scripts/*\n  Cache-Control: public, no-cache\n  X-Content-Type-Options: nosniff\n',
);
const secrets = [
  'CLERK_SECRET_KEY',
  'CLERK_WEBHOOK_SECRET',
  'ACCESS_JWT_SECRET',
  'SESSION_WRAP_SECRET',
]
  .map((name) => process.env[name])
  .filter((value) => value && value.length >= 16);
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else {
      const contents = readFileSync(path, 'utf8');
      if (
        /\b(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{16,})|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(
          contents,
        ) ||
        secrets.some((secret) => contents.includes(secret))
      ) {
        throw new Error(
          'Public build contains a possible server secret; refusing deployment artifacts.',
        );
      }
    }
  }
}
inspect(join(root, 'dist'));
