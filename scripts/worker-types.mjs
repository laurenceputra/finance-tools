import { readFileSync, writeFileSync } from 'node:fs';

// Scope Worker runtime globals to consumers of the generated binding file,
// rather than injecting them into web/userscript DOM projects via base config.
const path = new URL('../worker-configuration.d.ts', import.meta.url);
const reference = '/// <reference types="@cloudflare/workers-types" />';
const generated = readFileSync(path, 'utf8').replace(/^\/\/\/ <reference types="@cloudflare\/workers-types" \/>\r?\n/, '');
writeFileSync(path, `${reference}\n${generated.replace(/[\t ]+$/gm, '').trimEnd()}\n`);
