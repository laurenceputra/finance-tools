import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { StoredDocument, VaultResponse } from '@finance-tools/contracts';

// Real Chromium/React effects, Web Crypto, IndexedDB, fetch credentials and reloads.
// Only Clerk hooks and the API service are fixtures; no test alias enters the production build.
let browser: ReturnType<typeof spawn>,
  server: ReturnType<typeof createServer>,
  socket: WebSocket,
  profile: string;
let origin: string,
  bundle: string,
  vault: VaultResponse,
  doc: StoredDocument,
  settingsDoc: StoredDocument,
  active = false,
  account = 'acct-a';
const requests: { path: string; refreshId?: string; csrf?: string; cookie?: string }[] = [];
const deletions: { sub: string; fva: number[] }[] = [];
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const chrome =
  process.env.FINANCE_TEST_CHROME ??
  (process.arch === 'arm64'
    ? '/ms-playwright/chromium-1243/chrome-linux-arm64/chrome'
    : '/ms-playwright/chromium-1234/chrome-linux/chrome');
function command(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression: string) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}
const click = (text: string) =>
  evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(text)})?.click()`,
  );
const input = (label: string, value: string) =>
  evaluate(
    `(() => { const label = Array.from(document.querySelectorAll('label')).find(element => element.firstChild?.textContent.trim() === ${JSON.stringify(label)}); const element = label?.querySelector('input'); if (!element) throw new Error('Input missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
async function openDeletion(
  strategy: 'totp' | 'backup_code' | 'phone_code' | 'none',
  delayed = false,
) {
  const previous = await evaluate('window.fixture.loadId');
  await command('Page.reload');
  await waitFor(`!!window.fixture && window.fixture.loadId !== ${JSON.stringify(previous)}`);
  await evaluate('window.fixture.seed()');
  await evaluate('window.fixture.clerk("user-a")');
  await evaluate(`window.fixture.verification(${JSON.stringify(strategy)}, ${delayed})`);
  await evaluate('window.fixture.mount()');
  await waitFor('document.body.textContent.includes("Vault unlocked")');
  await click('Export & account');
  await click('Send fresh verification code');
  await waitFor(
    '!!Array.from(document.querySelectorAll("label")).find(label => label.firstChild?.textContent.trim() === "Fresh email verification code")',
  );
  await input('Fresh email verification code', 'email-code');
  await input('Type DELETE', 'DELETE');
}
function tokens() {
  const sid = `own-${account}`;
  return {
    accessToken: `e30.${Buffer.from(JSON.stringify({ sub: account, sid, scopes: ['settings', 'history'], products: ['portfolio', 'bank-subcaps'] })).toString('base64url')}.signature`,
    sessionId: sid,
    expiresIn: 900,
  };
}
beforeAll(async () => {
  const output = await build({
    entryPoints: [new URL('./browser-entry.tsx', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: {
      '@clerk/clerk-react': new URL('./clerk-fixture.tsx', import.meta.url).pathname,
      '@finance-tools/card-rules': new URL(
        '../../../packages/card-rules/src/index.ts',
        import.meta.url,
      ).pathname,
      '@finance-tools/portfolio-domain': new URL(
        '../../../packages/portfolio-domain/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  });
  bundle = output.outputFiles[0].text;
  server = createServer(async (req, res) => {
    const path = req.url!;
    let body = '';
    for await (const part of req) body += part;
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<div id="root"></div><script src="/fixture.js"></script>');
      return;
    }
    if (path === '/fixture.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(bundle);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (path === '/fixture/seed') {
      ({ vault, doc, settingsDoc } = JSON.parse(body));
      active = true;
      account = 'acct-a';
      res.setHeader('Set-Cookie', 'finance-test=active; HttpOnly; SameSite=Strict; Path=/');
      res.end('{}');
      return;
    }
    requests.push({
      path,
      refreshId: req.headers['x-finance-refresh-id'] as string,
      csrf: req.headers['x-finance-csrf'] as string,
      cookie: req.headers.cookie,
    });
    if (path === '/api/v1/session/logout') {
      active = false;
      res.statusCode = 204;
      res.setHeader('Set-Cookie', 'finance-test=; Max-Age=0; Path=/');
      res.end();
      return;
    }
    if (path === '/api/v1/session/exchange') {
      const input = JSON.parse(body);
      const subject = JSON.parse(
        Buffer.from(input.clerkToken.split('.')[1], 'base64url').toString(),
      ).sub;
      account = subject === 'user-b' ? 'acct-b' : 'acct-a';
      active = true;
      res.setHeader('Set-Cookie', 'finance-test=active; HttpOnly; SameSite=Strict; Path=/');
      res.end(JSON.stringify(tokens()));
      return;
    }
    if (!active || !req.headers.cookie?.includes('finance-test=active')) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: 'revoked' } }));
      return;
    }
    if (path === '/api/v1/session/refresh') {
      res.end(JSON.stringify(tokens()));
      return;
    }
    if (path === '/api/v1/me') {
      res.end(
        JSON.stringify({
          accountId: account,
          namespaces: ['settings', 'history'],
          products: ['portfolio', 'bank-subcaps'],
        }),
      );
      return;
    }
    if (path === '/api/v1/account' && req.method === 'DELETE') {
      const token = JSON.parse(body).clerkToken,
        claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (claims.sub !== 'user-a' || claims.fva?.[0] !== 0 || claims.fva?.[1] !== 0) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { code: 'reauth_required' } }));
        return;
      }
      deletions.push({ sub: claims.sub, fva: claims.fva });
      active = false;
      res.statusCode = 204;
      res.setHeader('Set-Cookie', 'finance-test=; Max-Age=0; Path=/');
      res.end();
      return;
    }
    if (path === '/api/v1/vault' && account === 'acct-a') {
      res.end(JSON.stringify(vault));
      return;
    }
    if (path.startsWith('/api/v1/documents/')) {
      res.end(
        JSON.stringify({
          documents:
            account === 'acct-a' ? (path.includes('/history') ? [doc] : [settingsDoc]) : [],
          cursor: null,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'missing' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile = await mkdtemp(`${tmpdir()}/finance-ui-`);
  browser = spawn(
    chrome,
    [
      '--headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const endpoint = await new Promise<string>((resolve, reject) => {
    let text = '';
    browser.stderr!.on('data', (chunk) => {
      text += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
      if (match) resolve(match[1]);
    });
    browser.on('error', reject);
  });
  const target = (await fetch(`http://${new URL(endpoint).host}/json/new?about:blank`, {
    method: 'PUT',
  }).then((response) => response.json())) as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve) =>
    socket.addEventListener('open', () => resolve(), { once: true }),
  );
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Page.navigate', { url: origin });
  await waitFor('!!window.fixture');
}, 30_000);
afterAll(async () => {
  socket?.close();
  browser?.kill();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 });
});
it.skipIf(!existsSync(chrome))(
  'restores Finance independently of Clerk, remembers across reload, explicitly connects/logs out and isolates a signed-in switch (requires preinstalled Chromium)',
  async () => {
    await evaluate('window.fixture.seed()');
    await evaluate('window.fixture.clerkLoaded(false)');
    await evaluate('window.fixture.mount()');
    await waitFor('document.body.textContent.includes("Vault unlocked")');
    await evaluate('window.fixture.clerkLoaded(true)');
    expect(await evaluate('window.fixture.state().accountId')).toBe('acct-a');
    expect(requests.some((request) => request.path.endsWith('/exchange'))).toBe(false);
    await waitFor(
      'document.body.textContent.includes("Browser allocation · target versus actual")',
    );
    expect(await evaluate('document.body.textContent.includes("Drift bps")')).toBe(true);
    await click('History');
    await waitFor('document.body.textContent.includes("owned-decrypted-snapshot")');
    const before = requests.filter(
      (request) => request.path.endsWith('/logout') || request.path.endsWith('/exchange'),
    ).length;
    await evaluate('window.fixture.clerk("user-a")');
    await evaluate('window.fixture.clerk(null)');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await evaluate('window.fixture.state().unlocked')).toBe(true);
    expect(
      requests.filter(
        (request) => request.path.endsWith('/logout') || request.path.endsWith('/exchange'),
      ),
    ).toHaveLength(before);
    await command('Page.reload');
    await waitFor('!!window.fixture');
    await evaluate('window.fixture.mount()');
    await waitFor('document.body.textContent.includes("Vault unlocked")');
    await click('History');
    await waitFor('document.body.textContent.includes("owned-decrypted-snapshot")');
    await click('Sign out');
    await waitFor('document.body.textContent.includes("Connect your browser")');
    expect(await evaluate('window.fixture.remembered()')).toBe(false);
    await evaluate('window.fixture.clerk("user-a")');
    await waitFor(
      '!document.querySelector("main")?.getAttribute("aria-busy") || document.querySelector("main").getAttribute("aria-busy") === "false"',
    );
    await click('Connect this browser');
    await waitFor('window.fixture.state().accountId === "acct-a"');
    const exchanges = requests.filter((request) => request.path.endsWith('/exchange')).length;
    await evaluate('window.fixture.clerk("user-b")');
    await waitFor('!window.fixture.state().accountId');
    expect(await evaluate('window.fixture.state().unlocked')).toBe(false);
    expect(requests.filter((request) => request.path.endsWith('/exchange'))).toHaveLength(
      exchanges,
    );
    await waitFor('document.querySelector("main")?.getAttribute("aria-busy") === "false"');
    await click('Connect this browser');
    await waitFor('window.fixture.state().accountId === "acct-b"');
    expect(
      requests
        .filter((request) => request.path.endsWith('/refresh'))
        .every(
          (request) =>
            /^[0-9a-f-]{36}$/.test(request.refreshId ?? '') &&
            request.csrf === '1' &&
            request.cookie?.includes('finance-test=active'),
        ),
    ).toBe(true);
    expect(await evaluate('document.body.textContent.includes("owned-decrypted-snapshot")')).toBe(
      false,
    );
  },
  30_000,
);

for (const strategy of ['totp', 'backup_code', 'phone_code'] as const) {
  it.skipIf(!existsSync(chrome))(
    `verifies fresh email and enrolled ${strategy} before account deletion`,
    async () => {
      const before = deletions.length;
      await openDeletion(strategy);
      await click('Verify email & continue deletion');
      await waitFor('document.body.textContent.includes("Second-factor method")');
      expect(deletions).toHaveLength(before);
      expect((await evaluate('window.fixture.verificationState()')).calls).not.toContain('token');
      if (strategy === 'phone_code') {
        await click('Send second-factor phone code');
        await waitFor('document.body.textContent.includes("sent to ***1234")');
      }
      await input('Second-factor code', 'second-code');
      await click('Verify MFA & permanently delete');
      await waitFor('!window.fixture.state().accountId');
      expect(deletions).toHaveLength(before + 1);
      expect(deletions.at(-1)?.fva).toEqual([0, 0]);
      const calls = (await evaluate('window.fixture.verificationState()')).calls as string[];
      expect(calls).toContain('start:multi_factor');
      expect(calls.indexOf('token')).toBeGreaterThan(calls.indexOf(`attempt:${strategy}`));
      if (strategy === 'phone_code')
        expect(calls.indexOf('prepare:phone')).toBeLessThan(calls.indexOf('attempt:phone_code'));
    },
    30000,
  );
}
for (const action of ['cancel', 'switch'] as const) {
  it.skipIf(!existsSync(chrome))(
    `blocks late MFA completion after ${action}`,
    async () => {
      const before = deletions.length;
      await openDeletion('totp', true);
      await click('Verify email & continue deletion');
      await waitFor('document.body.textContent.includes("Second-factor method")');
      await input('Second-factor code', 'second-code');
      await click('Verify MFA & permanently delete');
      await waitFor('window.fixture.verificationState().pending');
      if (action === 'cancel') await click('Cancel account deletion');
      else await evaluate('window.fixture.clerk("user-b")');
      await evaluate('window.fixture.resolveSecond()');
      await waitFor('document.querySelector("main")?.getAttribute("aria-busy") === "false"');
      expect(deletions).toHaveLength(before);
      expect((await evaluate('window.fixture.verificationState()')).calls).not.toContain('token');
    },
    30000,
  );
}
