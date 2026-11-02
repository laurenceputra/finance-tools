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
let rawKey: string | undefined,
  empty = false,
  refreshFailure = false;
const requests: { path: string; refreshId?: string; csrf?: string; cookie?: string }[] = [];
const deletions: { sub: string; fva: number[] }[] = [];
const modeChanges: { mode: string; fva: number[] }[] = [];
let refreshGate: { entered: () => void; released: Promise<void> } | undefined;
let rejectSensitive: string | undefined;
function pauseFinanceRefresh(rejectPath?: string) {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  refreshGate = { entered, released };
  rejectSensitive = rejectPath;
  return { waiting, release };
}
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
const click = async (text: string) => {
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some(button => button.textContent === ${JSON.stringify(text)} && !button.disabled)`,
  );
  return evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(text)})?.click()`,
  );
};
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
      empty = false;
      refreshFailure = false;
      rawKey = undefined;
      res.setHeader('Set-Cookie', 'finance-test=active; HttpOnly; SameSite=Strict; Path=/');
      res.end('{}');
      return;
    }
    if (path === '/fixture/fresh') {
      ({ vault, rawKey, refreshFailure } = JSON.parse(body));
      empty = true;
      active = !!JSON.parse(body).restoreActive;
      account = 'acct-a';
      res.setHeader(
        'Set-Cookie',
        active
          ? 'finance-test=active; HttpOnly; SameSite=Strict; Path=/'
          : 'finance-test=; Max-Age=0; Path=/',
      );
      res.end('{}');
      return;
    }
    requests.push({
      path,
      refreshId: req.headers['x-finance-refresh-id'] as string,
      csrf: req.headers['x-finance-csrf'] as string,
      cookie: req.headers.cookie,
    });
    if (path === rejectSensitive) {
      rejectSensitive = undefined;
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: 'expired' } }));
      return;
    }
    if (path === '/api/v1/session/refresh' && refreshGate) {
      const gate = refreshGate;
      refreshGate = undefined;
      gate.entered();
      await gate.released;
    }
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
    if (path === '/api/v1/session/refresh' && refreshFailure) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { code: 'transient' } }));
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
          clerkSubject: account === 'acct-a' ? 'user-a' : 'user-b',
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
    if (path === '/api/v1/vault/key') {
      if (!rawKey || JSON.parse(body).expectedRevision !== vault.revision) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: { code: 'private_key_required' } }));
        return;
      }
      res.end(JSON.stringify({ revision: vault.revision, keyVersion: 1, rawKey }));
      return;
    }
    if (path === '/api/v1/vault/mode') {
      const input = JSON.parse(body),
        claims = JSON.parse(Buffer.from(input.clerkToken.split('.')[1], 'base64url').toString());
      if (
        claims.sub !== 'user-a' ||
        claims.fva?.[0] !== 0 ||
        claims.fva?.[1] !== 0 ||
        input.expectedRevision !== vault.revision
      ) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { code: 'reverification_required' } }));
        return;
      }
      modeChanges.push({ mode: input.vault.mode, fva: claims.fva });
      vault = { revision: vault.revision + 1, vault: input.vault };
      rawKey = input.rawKey;
      res.end(JSON.stringify(vault));
      return;
    }
    if (path.startsWith('/api/v1/documents/')) {
      res.end(
        JSON.stringify({
          documents:
            account === 'acct-a' && !empty
              ? path.includes('/history')
                ? [doc]
                : [settingsDoc]
              : [],
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
    await waitFor('document.body.textContent.includes("Sign in to Finance")');
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

async function freshPage(mode = 'standard', failure = false) {
  const previous = await evaluate('window.fixture.loadId');
  await command('Page.reload');
  await waitFor(`!!window.fixture && window.fixture.loadId !== ${JSON.stringify(previous)}`);
  const file = await evaluate(`window.fixture.fresh(${JSON.stringify(mode)}, ${failure})`);
  await evaluate('window.fixture.mount()');
  await waitFor('document.body.textContent.includes("Sign in to Finance")');
  return file;
}

for (const timing of ['initial', 'delayed'] as const) {
  it.skipIf(!existsSync(chrome))(
    `rejects an account-A cookie with no local binding when Clerk identifies B (${timing})`,
    async () => {
      const previous = await evaluate('window.fixture.loadId');
      await command('Page.reload');
      await waitFor(`!!window.fixture && window.fixture.loadId !== ${JSON.stringify(previous)}`);
      await evaluate('window.fixture.fresh("standard", false, true)');
      await evaluate('window.fixture.clerk("user-b")');
      await evaluate(`window.fixture.clerkLoaded(${timing === 'initial'})`);
      const releases = requests.filter((request) => request.path === '/api/v1/vault/key').length;
      const exchanges = requests.filter((request) => request.path.endsWith('/exchange')).length;
      await evaluate('window.fixture.mount()');
      if (timing === 'delayed') {
        await waitFor('window.fixture.state().unlocked');
        await evaluate('window.fixture.clerkLoaded(true)');
      }
      await waitFor('document.body.textContent.includes("Connect this identity explicitly.")');
      expect(await evaluate('window.fixture.state().unlocked')).toBe(false);
      expect(await evaluate('window.fixture.state().accountId')).toBeUndefined();
      expect(
        await evaluate('document.body.textContent.includes("Portfolio & bank snapshots")'),
      ).toBe(false);
      expect(requests.filter((request) => request.path.endsWith('/exchange'))).toHaveLength(
        exchanges,
      );
      if (timing === 'initial')
        expect(requests.filter((request) => request.path === '/api/v1/vault/key')).toHaveLength(
          releases,
        );
    },
    30000,
  );
}

it.skipIf(!existsSync(chrome))(
  'restores a missing-binding legacy profile smoothly when the authoritative Clerk subject matches',
  async () => {
    const previous = await evaluate('window.fixture.loadId');
    await command('Page.reload');
    await waitFor(`!!window.fixture && window.fixture.loadId !== ${JSON.stringify(previous)}`);
    await evaluate('window.fixture.fresh("standard", false, true)');
    await evaluate('window.fixture.clerk("user-a")');
    const exchanges = requests.filter((request) => request.path.endsWith('/exchange')).length;
    await evaluate('window.fixture.mount()');
    await waitFor('document.body.textContent.includes("Portfolio & bank snapshots")');
    expect(await evaluate('window.fixture.state().accountId')).toBe('acct-a');
    expect(await evaluate('window.fixture.state().unlocked')).toBe(true);
    expect(requests.filter((request) => request.path.endsWith('/exchange'))).toHaveLength(
      exchanges,
    );
  },
  30000,
);

it.skipIf(!existsSync(chrome))(
  'fresh anonymous → verified Clerk identity → one automatic Standard exchange/dashboard under StrictMode; Clerk expiry and explicit Lock stay independent',
  async () => {
    await freshPage();
    expect(await evaluate('!!document.querySelector("[role=alert]")')).toBe(false);
    expect(await evaluate('!!document.querySelector("nav")')).toBe(false);
    const before = requests.filter((request) => request.path.endsWith('/exchange')).length;
    await evaluate('window.fixture.clerk("user-a")');
    await waitFor('document.body.textContent.includes("Portfolio & bank snapshots")');
    expect(await evaluate('window.fixture.state().unlocked')).toBe(true);
    expect(requests.filter((request) => request.path.endsWith('/exchange'))).toHaveLength(
      before + 1,
    );
    expect(await evaluate('window.fixture.remembered()')).toBe(false);
    await evaluate('window.fixture.clerk(null)');
    await click('Refresh decrypted views');
    await waitFor('document.querySelector("main")?.getAttribute("aria-busy") === "false"');
    expect(await evaluate('window.fixture.state().unlocked')).toBe(true);
    await click('Lock & forget this device');
    await waitFor('document.body.textContent.includes("Unlock Standard vault")');
    await evaluate('window.fixture.clerk("user-a")');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await evaluate('window.fixture.state().unlocked')).toBe(false);
    expect(requests.filter((request) => request.path.endsWith('/exchange'))).toHaveLength(
      before + 1,
    );
    await click('Unlock Standard vault');
    await waitFor('window.fixture.state().unlocked');
    await click('Sign out');
    await waitFor('!window.fixture.state().accountId');
    await evaluate('window.fixture.clerk("user-a")');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests.filter((request) => request.path.endsWith('/exchange'))).toHaveLength(
      before + 1,
    );
  },
  30000,
);

it.skipIf(!existsSync(chrome))(
  'fresh Private connection gates a new device until its account-bound key file is imported',
  async () => {
    const file = await freshPage('private');
    await evaluate('window.fixture.clerk("user-a")');
    await waitFor('document.body.textContent.includes("Private mode: bring your key file")');
    expect(await evaluate('window.fixture.state().unlocked')).toBe(false);
    expect(await evaluate('document.body.textContent.includes("Portfolio & bank snapshots")')).toBe(
      false,
    );
    await evaluate(
      `(() => { const input = Array.from(document.querySelectorAll('input[type=file]')).find(input => input.parentElement.textContent.includes('Import Private key')); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(file))}], 'key.json', { type: 'application/json' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    await waitFor('document.body.textContent.includes("Portfolio & bank snapshots")');
    expect(await evaluate('window.fixture.state().unlocked')).toBe(true);
  },
  30000,
);

it.skipIf(!existsSync(chrome))(
  'transient restoration failure never silently mints a new app session',
  async () => {
    await freshPage('standard', true);
    const before = requests.filter((request) => request.path.endsWith('/exchange')).length;
    await evaluate('window.fixture.clerk("user-a")');
    await waitFor('!!document.querySelector("[role=alert]")');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(requests.filter((request) => request.path.endsWith('/exchange'))).toHaveLength(before);
    expect(await evaluate('window.fixture.state().accountId')).toBeUndefined();
  },
  30000,
);

it.skipIf(!existsSync(chrome))(
  'Private opt-in requires key-file download/confirmation and fresh email plus MFA before committing; unlock retains key continuity',
  async () => {
    await freshPage();
    await evaluate('window.fixture.clerk("user-a")');
    await waitFor('window.fixture.state().unlocked');
    await evaluate('window.fixture.verification("totp")');
    await click('Vault');
    await input('Private-mode passphrase', 'private-mode-password');
    await click('Prepare Private key file');
    await waitFor('document.body.textContent.includes("Download Private key file")');
    expect(
      await evaluate(
        'Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Verify & enable Private mode").disabled',
      ),
    ).toBe(true);
    await click('Download Private key file');
    await evaluate(
      'Array.from(document.querySelectorAll("label")).find(label => label.textContent.includes("I saved my key file securely.")).querySelector("input").click()',
    );
    await click('Verify & enable Private mode');
    await waitFor('document.body.textContent.includes("Send mode-change verification code")');
    await click('Send mode-change verification code');
    await waitFor('document.body.textContent.includes("Mode-change email code")');
    const before = modeChanges.length;
    await input('Mode-change email code', 'email-code');
    await click('Verify & change encryption mode');
    await waitFor('document.body.textContent.includes("Mode-change MFA code")');
    expect(modeChanges).toHaveLength(before);
    expect((await evaluate('window.fixture.verificationState()')).calls).not.toContain('token');
    await input('Mode-change MFA code', 'second-code');
    await click('Verify & change encryption mode');
    await waitFor('document.body.textContent.includes("Encryption mode changed.")');
    expect(modeChanges.at(-1)).toEqual({ mode: 'private', fva: [0, 0] });
    expect(await evaluate('window.fixture.state().unlocked')).toBe(false);
    await input('Passphrase', 'private-mode-password');
    await click('Unlock existing vault');
    await waitFor('window.fixture.state().unlocked');
  },
  30000,
);

for (const pause of ['mfa', 'token', 'initial-refresh', 'retry-refresh'] as const) {
  it.skipIf(!existsSync(chrome))(
    `cancelling mode change during ${pause} never sends a mode mutation`,
    async () => {
      const file = await freshPage('private');
      await evaluate('window.fixture.clerk("user-a")');
      await waitFor('document.body.textContent.includes("Private mode: bring your key file")');
      await input('Passphrase', 'private-fixture-password');
      await click('Unlock existing vault');
      await waitFor('window.fixture.state().unlocked');
      await click('Vault');
      await evaluate(`window.fixture.verification("totp", ${pause === 'mfa'})`);
      await input('Passphrase', 'private-fixture-password');
      await evaluate(
        'Array.from(document.querySelectorAll("label")).find(label => label.textContent.includes("I trust this service")).querySelector("input").click()',
      );
      await click('Verify & enable Standard mode');
      await click('Send mode-change verification code');
      await waitFor('document.body.textContent.includes("Mode-change email code")');
      await input('Mode-change email code', 'email-code');
      await click('Verify & change encryption mode');
      await waitFor('document.body.textContent.includes("Mode-change MFA code")');
      await input('Mode-change MFA code', 'second-code');
      const before = modeChanges.length;
      const sent = requests.filter((request) => request.path === '/api/v1/vault/mode').length;
      if (pause === 'token') await evaluate('window.fixture.delayToken(true)');
      const refreshing = pause.endsWith('refresh')
        ? pauseFinanceRefresh(pause === 'retry-refresh' ? '/api/v1/vault/mode' : undefined)
        : undefined;
      if (pause === 'initial-refresh') await evaluate('window.fixture.forgetAccess()');
      await click('Verify & change encryption mode');
      if (refreshing) await refreshing.waiting;
      else
        await waitFor(
          `window.fixture.verificationState().${pause === 'token' ? 'pendingToken' : 'pending'}`,
        );
      await click('Cancel mode change');
      if (refreshing) refreshing.release();
      else
        await evaluate(`window.fixture.${pause === 'token' ? 'resolveToken' : 'resolveSecond'}()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(modeChanges).toHaveLength(before);
      expect(requests.filter((request) => request.path === '/api/v1/vault/mode')).toHaveLength(
        sent + (pause === 'retry-refresh' ? 1 : 0),
      );
      if (pause === 'mfa')
        expect((await evaluate('window.fixture.verificationState()')).calls).not.toContain('token');
      expect(file.accountId).toBe('acct-a');
    },
    30000,
  );
}

for (const pause of ['token', 'initial-refresh', 'retry-refresh'] as const) {
  it.skipIf(!existsSync(chrome))(
    `cancelling deletion during ${pause} never submits a subsequent account deletion`,
    async () => {
      await openDeletion('totp');
      await click('Verify email & continue deletion');
      await waitFor('document.body.textContent.includes("Second-factor method")');
      await input('Second-factor code', 'second-code');
      if (pause === 'token') await evaluate('window.fixture.delayToken(true)');
      const refreshing = pause.endsWith('refresh')
        ? pauseFinanceRefresh(pause === 'retry-refresh' ? '/api/v1/account' : undefined)
        : undefined;
      if (pause === 'initial-refresh') await evaluate('window.fixture.forgetAccess()');
      const before = deletions.length;
      const sent = requests.filter((request) => request.path === '/api/v1/account').length;
      await click('Verify MFA & permanently delete');
      if (refreshing) await refreshing.waiting;
      else await waitFor('window.fixture.verificationState().pendingToken');
      await click('Cancel account deletion');
      if (refreshing) refreshing.release();
      else await evaluate('window.fixture.resolveToken()');
      await waitFor('document.querySelector("main")?.getAttribute("aria-busy") === "false"');
      expect(deletions).toHaveLength(before);
      expect(requests.filter((request) => request.path === '/api/v1/account')).toHaveLength(
        sent + (pause === 'retry-refresh' ? 1 : 0),
      );
    },
    30000,
  );
}
