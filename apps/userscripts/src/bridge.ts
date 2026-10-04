// The only functions exposed to the page close over endpoint rules and this financial event name.
// No GM APIs, credentials, vault keys or sync functions enter these wrappers. No inline CSP bypass.
function pageBridge(eventName: string, page: Window & typeof globalThis) {
  const endpoints: Record<string, string[]> = {
    'app.sg.endowus.com': ['/v1/goals/performance', '/v2/goals/investible', '/v1/goals'],
    'api.sg.endowus.com': ['/v1/goals/performance', '/v2/goals/investible', '/v1/goals'],
    'api.endowus.com': ['/v1/goals/performance', '/v2/goals/investible', '/v1/goals'],
    'secure.fundsupermart.com': ['/fsmone/rest/holding/client/protected/find-holdings-with-pnl'],
    'internet.ocbc.com': ['/digital/api/sg/ms-investment-accounts/v1/portfolio-holdings/inquiry'],
  };
  function permitted(input: string, method: string) {
    try {
      const url = new URL(input, location.href);
      const provider = location.hostname;
      const sameProvider =
        provider === 'app.sg.endowus.com'
          ? ['app.sg.endowus.com', 'api.sg.endowus.com', 'api.endowus.com'].includes(url.hostname)
          : url.hostname === provider;
      return sameProvider &&
        url.protocol === 'https:' &&
        !url.port &&
        endpoints[url.hostname]?.includes(url.pathname) &&
        (url.hostname === 'internet.ocbc.com' ? method === 'POST' : method === 'GET')
        ? url.pathname
        : undefined;
    } catch {
      return undefined;
    }
  }
  function accountContext() {
    return (
      document.documentElement?.getAttribute('data-account-context') ??
      document.documentElement?.getAttribute('data-customer-id') ??
      undefined
    );
  }
  function emit(
    path: string,
    payload: unknown,
    context: { route: string; startedAt: string; accountContext?: string },
  ) {
    try {
      const detail = JSON.stringify({
        path,
        payload,
        ...context,
        capturedAt: new Date().toISOString(),
      });
      if (detail.length <= 2_000_000)
        document.dispatchEvent(new CustomEvent(eventName, { detail }));
    } catch {
      /* Ignore non-JSON financial payloads. */
    }
  }
  const originalFetch = page.fetch,
    prototype = page.XMLHttpRequest?.prototype;
  if (
    typeof originalFetch !== 'function' ||
    !prototype ||
    typeof prototype.open !== 'function' ||
    typeof prototype.send !== 'function'
  )
    throw new Error('Page capture APIs unavailable');
  const open = prototype.open,
    send = prototype.send,
    paths = new WeakMap<
      XMLHttpRequest,
      { path: string; route: string; startedAt: string; accountContext?: string } | undefined
    >();
  const listeners = new WeakMap<XMLHttpRequest, EventListener>();
  const expose = <T extends Function>(callback: T): T =>
    typeof exportFunction === 'function' ? (exportFunction(callback, page) as T) : callback;
  const wrappedFetch = expose(function (this: Window, ...args: Parameters<typeof fetch>) {
    const request = args[0],
      method = (
        args[1]?.method ?? (request instanceof page.Request ? request.method : 'GET')
      ).toUpperCase(),
      path = permitted(request instanceof page.Request ? request.url : String(request), method);
    const context = {
      route: location.href,
      startedAt: new Date().toISOString(),
      accountContext: accountContext(),
    };
    const promise = originalFetch.apply(this, args);
    if (path)
      void promise
        .then((response) => {
          if (response.ok)
            void response
              .clone()
              .text()
              .then((body) => {
                if (body.length <= 2_000_000) {
                  try {
                    emit(path, JSON.parse(body), context);
                  } catch {
                    /* Non JSON. */
                  }
                }
              })
              .catch(() => {});
        })
        .catch(() => {});
    return promise;
  });
  const wrappedOpen = expose(function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const previous = listeners.get(this);
    if (previous) this.removeEventListener('load', previous);
    listeners.delete(this);
    const path = permitted(String(url), String(method).toUpperCase());
    paths.set(
      this,
      path
        ? {
            path,
            route: location.href,
            startedAt: new Date().toISOString(),
            accountContext: accountContext(),
          }
        : undefined,
    );
    return Reflect.apply(open, this, [method, url, ...rest]);
  } as typeof open);
  const wrappedSend = expose(function (this: XMLHttpRequest, ...args: Parameters<typeof send>) {
    const context = paths.get(this);
    if (context) {
      const listener = () => {
        if (paths.get(this) !== context || this.status < 200 || this.status >= 300) return;
        try {
          const payload =
            this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          emit(context.path, payload, context);
        } catch {
          /* Preserve native response and status. */
        }
      };
      listeners.set(this, listener);
      this.addEventListener('load', listener, { once: true });
    }
    return send.apply(this, args);
  });
  const rollback = () => {
    try {
      if (page.fetch === wrappedFetch) page.fetch = originalFetch;
    } catch {}
    try {
      if (prototype.open === wrappedOpen) prototype.open = open;
    } catch {}
    try {
      if (prototype.send === wrappedSend) prototype.send = send;
    } catch {}
  };
  try {
    page.fetch = wrappedFetch;
    prototype.open = wrappedOpen;
    prototype.send = wrappedSend;
    if (
      page.fetch !== wrappedFetch ||
      prototype.open !== wrappedOpen ||
      prototype.send !== wrappedSend
    )
      throw new Error('Page bridge installation refused');
  } catch (error) {
    rollback();
    throw error;
  }
  return rollback;
}
export function installBridge(
  receive: (data: {
    path: string;
    payload: unknown;
    capturedAt: string;
    route?: string;
    startedAt?: string;
    accountContext?: string;
  }) => void,
) {
  const eventName = `finance-capture-${crypto.randomUUID()}`;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string' || detail.length > 2_000_000) return;
    try {
      const value = JSON.parse(detail);
      if (typeof value.path === 'string' && typeof value.capturedAt === 'string') receive(value);
    } catch {
      /* Untrusted page data never becomes a credential. */
    }
  };
  document.addEventListener(eventName, listener);
  try {
    const rollback = pageBridge(eventName, unsafeWindow);
    return {
      available: true,
      uninstall: () => {
        rollback();
        document.removeEventListener(eventName, listener);
      },
    };
  } catch {
    document.removeEventListener(eventName, listener);
    return {
      available: false,
      uninstall: () => {},
      error:
        'Capture bridge unavailable. Manager page-realm access or Firefox exportFunction support is required; no partial interception remains.',
    };
  }
}
