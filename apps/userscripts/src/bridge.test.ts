import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from './bridge';
class FakeXHR extends EventTarget {
  status = 200;
  responseType = '';
  responseText = '{"data":[]}';
  response: unknown;
  open(_method: string, _url: string) {
    /* Native placeholder for wrapper tests. */
  }
  send() {
    this.dispatchEvent(new Event('load'));
  }
}
afterEach(() => vi.unstubAllGlobals());
describe('page financial capture boundary', () => {
  it('does not relabel a reused/aborted XHR response as an earlier Endowus component', () => {
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('location', {
      href: 'https://app.sg.endowus.com/dashboard',
      hostname: 'app.sg.endowus.com',
    });
    class XHR extends FakeXHR {
      send() {}
    }
    const page = { fetch: vi.fn(), Request, XMLHttpRequest: XHR } as unknown as Window &
      typeof globalThis;
    vi.stubGlobal('unsafeWindow', page);
    const receive = vi.fn();
    const installed = installBridge(receive);
    expect(installed.available).toBe(true);
    const xhr = new XHR();
    xhr.open('GET', '/v1/goals/performance');
    xhr.send();
    xhr.open('GET', '/v2/goals/investible');
    xhr.send();
    xhr.dispatchEvent(new Event('load'));
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0][0].path).toBe('/v2/goals/investible');
    installed.uninstall();
  });
  it('exports only the three financial wrappers for Firefox and rolls back a partial failed install', () => {
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('location', {
      href: 'https://secure.fundsupermart.com/fsmone/',
      hostname: 'secure.fundsupermart.com',
    });
    const exporter = vi.fn((callback: Function) => callback);
    vi.stubGlobal('exportFunction', exporter);
    class XHR extends FakeXHR {}
    const native = vi.fn(async () => new Response('{}'));
    const page = { fetch: native, Request, XMLHttpRequest: XHR } as unknown as Window &
      typeof globalThis;
    vi.stubGlobal('unsafeWindow', page);
    const originalOpen = XHR.prototype.open;
    Object.defineProperty(XHR.prototype, 'send', {
      value: FakeXHR.prototype.send,
      writable: false,
    });
    const result = installBridge(vi.fn());
    expect(result.available).toBe(false);
    expect(exporter).toHaveBeenCalledTimes(3);
    expect(page.fetch).toBe(native);
    expect(XHR.prototype.open).toBe(originalOpen);
    expect(Object.keys(page).sort()).toEqual(['Request', 'XMLHttpRequest', 'fetch']);
  });
  it('preserves fetch response identity/status and emits only allowlisted successful financial payloads', async () => {
    const document = new EventTarget();
    const response = new Response('{"data":[]}', { status: 200 });
    const native = vi.fn(async () => response);
    const page = { fetch: native, Request, XMLHttpRequest: FakeXHR } as unknown as Window &
      typeof globalThis;
    vi.stubGlobal('document', document);
    vi.stubGlobal('location', {
      href: 'https://secure.fundsupermart.com/fsmone/holdings/investments',
      hostname: 'secure.fundsupermart.com',
    });
    vi.stubGlobal('unsafeWindow', page);
    const receive = vi.fn();
    installBridge(receive);
    expect(
      await page.fetch(
        'https://secure.fundsupermart.com/fsmone/rest/holding/client/protected/find-holdings-with-pnl',
      ),
    ).toBe(response);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(receive.mock.calls[0][0].payload).toEqual({ data: [] });
    await page.fetch('https://secure.fundsupermart.com/fsmone/rest/session/credentials');
    await page.fetch(
      'https://attacker.example/fsmone/rest/holding/client/protected/find-holdings-with-pnl',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receive).toHaveBeenCalledTimes(1);
    const failed = new Response('{"error":"denied"}', { status: 403 });
    native.mockResolvedValue(failed);
    expect(
      (
        await page.fetch(
          'https://secure.fundsupermart.com/fsmone/rest/holding/client/protected/find-holdings-with-pnl',
        )
      ).status,
    ).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it('retains XHR status and captures an exact scoped OCBC POST endpoint', () => {
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('location', {
      href: 'https://internet.ocbc.com/internet-banking/digital/web/sg/cfo/',
      hostname: 'internet.ocbc.com',
    });
    class XHR extends FakeXHR {}
    const page = { fetch: vi.fn(), Request, XMLHttpRequest: XHR } as unknown as Window &
      typeof globalThis;
    vi.stubGlobal('unsafeWindow', page);
    const receive = vi.fn();
    installBridge(receive);
    const xhr = new page.XMLHttpRequest();
    xhr.open(
      'POST',
      'https://internet.ocbc.com/digital/api/sg/ms-investment-accounts/v1/portfolio-holdings/inquiry',
    );
    xhr.send();
    expect(xhr.status).toBe(200);
    expect(receive).toHaveBeenCalledTimes(1);
    const denied = new XHR();
    denied.status = 401;
    denied.open(
      'POST',
      'https://internet.ocbc.com/digital/api/sg/ms-investment-accounts/v1/portfolio-holdings/inquiry',
    );
    denied.send();
    expect(denied.status).toBe(401);
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
