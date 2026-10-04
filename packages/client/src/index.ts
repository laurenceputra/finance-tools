import type {
  DocumentListResponse,
  EncryptedEnvelope,
  ExportResponse,
  MeResponse,
  Namespace,
  Product,
  SessionTokens,
  StoredDocument,
  VaultResponse,
} from '@finance-tools/contracts';
import {
  documentPutRequestSchema,
  encryptedEnvelopeSchema,
  idSchema,
  namespaceSchema,
  productSchema,
  vaultSchema,
} from '@finance-tools/contracts';
import {
  createVault,
  decodeBase64url,
  decryptJson,
  encryptJson,
  recoverVault,
  rewrapVaultPassphrase,
  unlockVault,
} from '@finance-tools/crypto';
import { validateJson, validateProductDocument } from './data';
import { timestampSchema } from '@finance-tools/portfolio-domain';
export { validateSettings, validateProductDocument } from './data';
export { previewLegacyConfig } from './legacy';

export const API = 'https://finance.laurenceputra.com/api/v1';
const MAX_BODY_BYTES = Math.ceil(1.1 * 1024 * 1024);
function checkBodySize(body: unknown) {
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_BODY_BYTES)
    throw new ApiFailure(413, 'body_too_large');
}
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys?(): Promise<string[]>;
}
export type { Product } from '@finance-tools/contracts';
export type Coordinator = <T>(task: (assertOwned: () => void) => Promise<T>) => Promise<T>;
export type Transport = (
  path: string,
  method: string,
  body: unknown,
  token?: string,
  headers?: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`Request failed (${status}, ${code})`);
  }
}
export function browserTransport(base = API): Transport {
  return async (path, method, body, token, headers) => {
    const response = await fetch(base + path, {
      method,
      credentials: 'include',
      signal: AbortSignal.timeout(path === '/export' ? 120_000 : 15_000),
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'X-Finance-CSRF': '1' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: response.status === 204 ? undefined : await response.json(),
    };
  };
}
export function calendarCutoff(now = new Date()): Date {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
  const last = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(day, last));
  return cutoff;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Not JSON');
  return result;
}
async function fingerprint(value: unknown) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
// Three-way reconciliation preserves remote edits. Same-field divergent changes require a user decision.
export function mergeSettings(base: unknown, remote: unknown, local: unknown): unknown {
  const equal = (a: unknown, b: unknown) =>
    a === undefined || b === undefined ? a === b : canonical(a) === canonical(b);
  if (equal(remote, local) || equal(base, local)) return remote;
  if (equal(base, remote)) return local;
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (record(remote) && record(local) && (base === undefined || record(base))) {
    const original = record(base) ? base : {},
      result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const own = (value: Record<string, unknown>, key: string) =>
      Object.hasOwn(value, key) ? value[key] : undefined;
    for (const key of new Set([
      ...Object.keys(original),
      ...Object.keys(remote),
      ...Object.keys(local),
    ])) {
      const merged = mergeSettings(own(original, key), own(remote, key), own(local, key));
      if (merged !== undefined) result[key] = merged;
    }
    return result;
  }
  throw new Error(
    'Concurrent edits changed the same setting. Reload and reconcile that field before saving.',
  );
}
export function mergeSnapshots(remote: unknown, local: unknown): unknown {
  if (canonical(remote) === canonical(local)) return remote;
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (
    !record(remote) ||
    !record(local) ||
    remote.id !== local.id ||
    remote.accountId !== local.accountId ||
    remote.card !== local.card
  )
    throw new Error('Snapshot conflict: identity mismatch');
  const field =
    Array.isArray(remote.transactions) && Array.isArray(local.transactions)
      ? 'transactions'
      : Array.isArray(remote.holdings) && Array.isArray(local.holdings)
        ? 'holdings'
        : undefined;
  if (
    !field ||
    !record(remote.provenance) ||
    !record(local.provenance) ||
    remote.provenance.provider !== local.provenance.provider
  )
    throw new Error('Snapshot conflict: unsupported format');
  const rows = new Map<string, unknown>();
  for (const row of [...(remote[field] as unknown[]), ...(local[field] as unknown[])]) {
    if (!record(row) || typeof row.id !== 'string')
      throw new Error('Snapshot conflict: missing row identity');
    const previous = rows.get(row.id);
    if (previous && canonical(previous) !== canonical(row))
      throw new Error(
        'Snapshot conflict: the same transaction or holding changed. Review before retrying.',
      );
    rows.set(row.id, row);
  }
  // Only identical metadata and append-only records can be reconciled automatically.
  const metadata = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== field && key !== 'provenance'),
    );
  if (canonical(metadata(remote)) !== canonical(metadata(local)))
    throw new Error('Snapshot conflict: metadata changed');
  const flags = [
    ...new Set([
      ...(Array.isArray(remote.provenance.flags) ? remote.provenance.flags : []),
      ...(Array.isArray(local.provenance.flags) ? local.provenance.flags : []),
      'CLIENT_CONFLICT_MERGE',
    ]),
  ];
  return {
    ...remote,
    [field]: [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    provenance: { ...remote.provenance, complete: false, flags },
  };
}
export class FinanceClient {
  private access?: string;
  private tokenAccountId?: string;
  private refreshFlight?: Promise<void>;
  private generation = 0;
  private key?: CryptoKey;
  private storageFlight: Promise<unknown> = Promise.resolve();
  me?: MeResponse;
  vault?: VaultResponse;
  onLock: (propagate?: boolean) => void = () => {};
  constructor(
    public transport: Transport,
    public storage: Storage,
    public kind: 'browser' | 'userscript',
    private coordinate: Coordinator = (task) => task(() => {}),
    public products: Product[] = ['portfolio', 'bank-subcaps'],
  ) {}
  private guard(epoch: number, account?: string) {
    if (epoch !== this.generation || (account !== undefined && account !== this.me?.accountId))
      throw new Error('Operation cancelled: account changed or vault locked');
  }
  private async stored(action: () => Promise<void>, guard: () => void = () => {}) {
    const work = this.storageFlight
      .catch(() => {})
      .then(async () => {
        guard();
        await action();
        guard();
      });
    this.storageFlight = work;
    await work;
  }
  private async raw<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    const result = await this.transport(path, method, body, token, headers);
    if (result.status >= 400)
      throw new ApiFailure(
        result.status,
        (result.body as { error?: { code?: string } })?.error?.code ?? 'request_failed',
      );
    return result.body as T;
  }
  async publicRequest<T>(path: string, body?: unknown): Promise<T> {
    return this.raw(path, body === undefined ? 'GET' : 'POST', body);
  }
  private async mutation<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const epoch = this.generation,
      account = this.account(),
      check = () => this.guard(epoch, account);
    const key = `mutation:${account}:${path}`,
      digest = await fingerprint(payload);
    check();
    let saved = await this.storage.get<{ digest: string; body: unknown }>(key);
    check();
    if (!saved || saved.digest !== digest) {
      saved = { digest, body: { ...payload, mutationId: crypto.randomUUID() } };
      const value = saved;
      await this.stored(() => this.storage.set(key, value), check);
    }
    check();
    const result = await this.request<T>(path, 'PUT', saved.body);
    check();
    await this.stored(() => this.storage.delete(key), check);
    return result;
  }
  private async accept(tokens: SessionTokens, epoch: number, fence: () => void = () => {}) {
    const check = () => {
      this.guard(epoch);
      fence();
    };
    check();
    let accountId: string;
    let namespaces: Namespace[] | undefined, products: Product[] | undefined;
    try {
      const parts = tokens.accessToken.split('.');
      if (parts.length !== 3 || tokens.accessToken.length > 16384) throw new Error();
      const payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(parts[1])),
      );
      accountId = idSchema.parse(payload.sub);
      if (payload.sid !== tokens.sessionId) throw new Error();
      if (Array.isArray(payload.scopes))
        namespaces = payload.scopes.map((value: unknown) => namespaceSchema.parse(value));
      if (Array.isArray(payload.products))
        products = payload.products.map((value: unknown) => productSchema.parse(value));
    } catch {
      throw new Error('Invalid Finance session response');
    }
    if (this.kind === 'userscript') {
      if (!tokens.refreshToken) throw new Error('Missing script credential');
      await this.stored(() => this.storage.set('refresh', tokens.refreshToken), check);
    }
    check();
    if (
      (this.me && this.me.accountId !== accountId) ||
      (this.tokenAccountId && this.tokenAccountId !== accountId)
    ) {
      check();
      this.abandonAccount();
      throw new Error(
        'Session account changed. Reconnect the intended identity; old keys and views were cleared.',
      );
    }
    if (this.me)
      this.me = {
        ...this.me,
        namespaces: namespaces ?? this.me.namespaces,
        products: products ?? this.me.products,
      };
    check();
    this.access = tokens.accessToken;
    this.tokenAccountId = accountId;
  }
  private abandonAccount() {
    this.generation++;
    this.access = undefined;
    this.tokenAccountId = undefined;
    this.me = undefined;
    this.vault = undefined;
    this.key = undefined;
    this.onLock(false);
  }
  async exchange(clerkToken: string) {
    const locking = this.lock(),
      epoch = this.generation;
    await locking;
    this.guard(epoch);
    this.me = undefined;
    this.vault = undefined;
    this.access = undefined;
    this.tokenAccountId = undefined;
    await this.coordinate(async (fence) => {
      this.guard(epoch);
      fence();
      const tokens = await this.raw<SessionTokens>('/session/exchange', 'POST', {
        clerkToken,
        client: {
          kind: 'browser',
          name: 'Finance dashboard',
          namespaces: ['settings', 'history'],
          products: this.products,
        },
      });
      await this.accept(tokens, epoch, fence);
    });
    await this.initialize();
  }
  async redeem(pairingId: string, secret: string) {
    const locking = this.lock(),
      epoch = this.generation;
    await locking;
    this.guard(epoch);
    this.me = undefined;
    this.vault = undefined;
    this.access = undefined;
    this.tokenAccountId = undefined;
    await this.coordinate(async (fence) => {
      this.guard(epoch);
      fence();
      await this.accept(
        await this.raw('/pairing/redeem', 'POST', { pairingId, secret }),
        epoch,
        fence,
      );
    });
    await this.initialize();
  }
  async refresh() {
    if (!this.refreshFlight) {
      const epoch = this.generation;
      this.refreshFlight = this.coordinate(async (fence) => {
        const check = () => {
          this.guard(epoch);
          fence();
        };
        try {
          const refreshToken =
            this.kind === 'userscript' ? await this.storage.get<string>('refresh') : undefined;
          check();
          if (this.kind === 'userscript' && !refreshToken)
            throw new Error('Disconnected: pair this script before renewing a session');
          let attempt = await this.storage.get<{ id: string; refreshToken?: string }>(
            'refresh-attempt',
          );
          check();
          if (!attempt || attempt.refreshToken !== refreshToken) {
            attempt = { id: crypto.randomUUID(), ...(refreshToken ? { refreshToken } : {}) };
            const saved = attempt;
            await this.stored(() => this.storage.set('refresh-attempt', saved), check);
          }
          check();
          const tokens = await this.raw<SessionTokens>(
            '/session/refresh',
            'POST',
            refreshToken ? { refreshToken } : {},
            undefined,
            { 'X-Finance-Refresh-Id': attempt.id },
          );
          check();
          await this.accept(tokens, epoch, fence);
          await this.stored(() => this.storage.delete('refresh-attempt'), check);
        } catch (error) {
          if (error instanceof ApiFailure && error.status === 401 && epoch === this.generation) {
            try {
              fence();
            } catch (lost) {
              this.abandonAccount();
              throw lost;
            }
            await this.forgetSession(fence);
          }
          throw error;
        }
      }).finally(() => {
        this.refreshFlight = undefined;
      });
    }
    return this.refreshFlight;
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const epoch = this.generation;
    if (!this.access) await this.refresh();
    this.guard(epoch);
    try {
      const result = await this.raw<T>(path, method, body, this.access);
      this.guard(epoch);
      return result;
    } catch (error) {
      this.guard(epoch);
      if (!(error instanceof ApiFailure) || error.status !== 401) throw error;
      await this.refresh();
      this.guard(epoch);
      const result = await this.raw<T>(path, method, body, this.access);
      this.guard(epoch);
      return result;
    }
  }
  async initialize() {
    const epoch = this.generation;
    await this.purgeLocalHistory();
    this.guard(epoch);
    const me = await this.request<MeResponse>('/me');
    this.guard(epoch);
    if (this.tokenAccountId !== me.accountId) {
      this.abandonAccount();
      throw new Error('Session identity does not match account metadata');
    }
    let vault: VaultResponse | undefined;
    try {
      vault = await this.request<VaultResponse>('/vault');
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
    }
    this.guard(epoch);
    const saved = await this.storage.get<{
      accountId: string;
      keyVersion: number;
      key?: CryptoKey;
      recoverySecret?: string;
    }>('remembered');
    this.guard(epoch);
    let rememberedKey: CryptoKey | undefined;
    if (saved && saved.accountId === me.accountId && saved.keyVersion === vault?.vault.keyVersion) {
      if (saved.key instanceof CryptoKey) rememberedKey = saved.key;
      else if (saved.recoverySecret && this.kind === 'userscript' && vault)
        rememberedKey = await recoverVault(me.accountId, vault.vault, saved.recoverySecret);
    } else if (saved)
      await this.stored(
        () => this.storage.delete('remembered'),
        () => this.guard(epoch),
      );
    this.guard(epoch);
    if (
      (this.me && this.me.accountId !== me.accountId) ||
      (this.vault && this.vault.vault.keyVersion !== vault?.vault.keyVersion)
    ) {
      this.generation++;
      this.key = undefined;
      this.onLock();
    }
    this.me = me;
    this.vault = vault;
    if (rememberedKey) this.key = rememberedKey;
  }
  get unlocked() {
    return !!this.key;
  }
  get lockEpoch() {
    return this.generation;
  }
  async purgeLocalHistory() {
    if (!this.storage.keys) return;
    const epoch = this.generation,
      keys = await this.storage.keys();
    this.guard(epoch);
    for (const key of keys) {
      const scope = key.split(':')[2];
      if (
        !key.startsWith('mutation:') ||
        (scope !== 'history' && !scope?.startsWith('/documents/history/'))
      )
        continue;
      const queued = await this.storage.get<{
        occurredAt?: string;
        body?: { occurredAt?: string };
      }>(key);
      this.guard(epoch);
      const occurredAt = queued?.body?.occurredAt ?? queued?.occurredAt;
      if (occurredAt && new Date(occurredAt) < calendarCutoff())
        await this.stored(
          () => this.storage.delete(key),
          () => this.guard(epoch),
        );
    }
  }
  async lock(fence: () => void = () => {}) {
    fence();
    this.generation++;
    this.key = undefined;
    this.onLock();
    await this.stored(() => this.storage.delete('remembered'), fence);
  }
  async forgetSession(fence: () => void = () => {}) {
    fence();
    this.access = undefined;
    this.tokenAccountId = undefined;
    this.me = undefined;
    this.vault = undefined;
    await this.lock(fence);
    await this.stored(async () => {
      fence();
      await this.storage.delete('refresh');
      fence();
      await this.storage.delete('refresh-attempt');
    }, fence);
  }
  async disconnect(all = false) {
    if (all) {
      // Step down decrypted access immediately, but obtain a live own JWT for the revoke-all command.
      // This is a deliberate renewal for this user action, not a Clerk exchange/new session.
      const locking = this.lock(),
        epoch = this.generation;
      try {
        await locking;
        this.guard(epoch);
        if (this.refreshFlight) await this.refreshFlight.catch(() => {});
        this.guard(epoch);
        await this.refresh();
        this.guard(epoch);
      } catch (error) {
        if (epoch === this.generation) await this.forgetSession();
        throw error;
      }
    }
    const token = this.access,
      refresh =
        this.kind === 'userscript'
          ? this.storage.get<string>('refresh')
          : Promise.resolve(undefined);
    const cleanup = this.forgetSession(),
      epoch = this.generation;
    try {
      const refreshToken = await refresh;
      await cleanup;
      this.guard(epoch);
      await this.coordinate(async (fence) => {
        this.guard(epoch);
        fence();
        await this.raw(
          all ? '/session/logout-all' : '/session/logout',
          'POST',
          !all && refreshToken ? { refreshToken } : {},
          token,
        );
        this.guard(epoch);
        fence();
      });
    } finally {
      await cleanup;
    }
  }
  private account() {
    if (!this.me) throw new Error('Connect first');
    return this.me.accountId;
  }
  async loadVault() {
    const epoch = this.generation,
      account = this.account();
    const vault = await this.request<VaultResponse>('/vault');
    this.guard(epoch, account);
    if (this.vault && this.vault.vault.keyVersion !== vault.vault.keyVersion) {
      const locking = this.lock(),
        changedEpoch = this.generation;
      await locking;
      this.guard(changedEpoch, account);
      this.vault = vault;
      throw new Error('Vault key version changed. Old keys/views were cleared; unlock again.');
    }
    this.vault = vault;
    return vault;
  }
  async unlock(credential: string, recovery = false, remember = false) {
    if (remember && this.kind === 'userscript' && !recovery)
      throw new Error('Script remember requires recovery-key unlock (GM cannot persist CryptoKey)');
    const generation = this.generation,
      account = this.account(),
      { vault } = await this.loadVault();
    const key = await (recovery
      ? recoverVault(account, vault, credential)
      : unlockVault(account, vault, credential));
    if (generation !== this.generation || account !== this.me?.accountId)
      throw new Error('Account changed or vault locked');
    this.key = key;
    if (remember) {
      await this.stored(
        () =>
          this.storage.set('remembered', {
            accountId: account,
            keyVersion: vault.keyVersion,
            ...(this.kind === 'userscript' ? { recoverySecret: credential } : { key }),
          }),
        () => this.guard(generation, account),
      );
    }
  }
  async prepareVault(passphrase: string) {
    const accountId = this.account(),
      epoch = this.generation;
    const prepared = await createVault(accountId, passphrase);
    this.guard(epoch, accountId);
    return { ...prepared, accountId, epoch };
  }
  async finishVault(prepared: Awaited<ReturnType<FinanceClient['prepareVault']>>) {
    const account = this.account(),
      epoch = this.generation;
    if (prepared.accountId !== account || prepared.epoch !== epoch)
      throw new Error('Prepared vault belongs to a different account or lock epoch');
    const vault = await this.mutation<VaultResponse>('/vault', {
      expectedRevision: 0,
      vault: prepared.vault,
    });
    this.guard(epoch, account);
    this.vault = vault;
    this.key = prepared.vaultKey;
  }
  async rewrap(oldCredential: string, newPassphrase: string, recovery = false) {
    const epoch = this.generation,
      account = this.account(),
      check = () => this.guard(epoch, account);
    const current = await this.loadVault();
    check();
    const queueKey = `mutation:${account}:/vault`;
    const pending = await this.storage.get<{
      body: { expectedRevision: number; mutationId: string; vault: VaultResponse['vault'] };
    }>(queueKey);
    check();
    if (
      pending &&
      pending.body.vault.keyVersion === current.vault.keyVersion &&
      canonical(pending.body.vault.recoveryEnvelope) === canonical(current.vault.recoveryEnvelope)
    ) {
      let sameIntent = false;
      try {
        await unlockVault(account, pending.body.vault, newPassphrase);
        sameIntent = true;
      } catch {
        /* A different intended passphrase requires a new CAS mutation. */
      }
      check();
      if (sameIntent && canonical(pending.body.vault) === canonical(current.vault)) {
        await this.stored(() => this.storage.delete(queueKey), check);
        return;
      }
      if (sameIntent && pending.body.expectedRevision === current.revision) {
        const vault = await this.request<VaultResponse>('/vault', 'PUT', pending.body);
        check();
        this.vault = vault;
        await this.stored(() => this.storage.delete(queueKey), check);
        return;
      }
    }
    const vault = await rewrapVaultPassphrase(
      account,
      current.vault,
      recovery ? { recoverySecret: oldCredential } : { passphrase: oldCredential },
      newPassphrase,
    );
    check();
    const result = await this.mutation<VaultResponse>('/vault', {
      expectedRevision: current.revision,
      vault,
    });
    check();
    this.vault = result;
  }
  private context(namespace: Namespace, id: string, keyVersion = this.vault?.vault.keyVersion) {
    if (!keyVersion) throw new Error('Vault unavailable');
    return {
      accountId: this.account(),
      namespace,
      documentId: id,
      schemaVersion: 1 as const,
      keyVersion,
    };
  }
  async decrypt<T = unknown>(doc: StoredDocument): Promise<T> {
    if (!this.key) throw new Error('Unlock first');
    const generation = this.generation,
      account = this.account();
    idSchema.parse(doc.id);
    namespaceSchema.parse(doc.namespace);
    productSchema.parse(doc.product);
    timestampSchema.parse(doc.updatedAt);
    if (!Number.isSafeInteger(doc.revision) || doc.revision < 1)
      throw new Error('Invalid stored document revision');
    if (
      !this.me?.namespaces.includes(doc.namespace) ||
      !this.me.products.includes(doc.product) ||
      !this.products.includes(doc.product)
    )
      throw new ApiFailure(403, 'scope');
    const result = await decryptJson<T>(
      this.key,
      doc.envelope,
      this.context(doc.namespace, doc.id, doc.envelope.keyVersion),
    );
    this.guard(generation, account);
    return validateProductDocument(doc.product, doc.namespace, result, doc.occurredAt) as T;
  }
  async list(namespace: Namespace, cursor?: string) {
    if (!this.me?.namespaces.includes(namespace)) throw new ApiFailure(403, 'scope');
    return this.request<DocumentListResponse>(
      `/documents/${namespace}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
  }
  async all(namespace: Namespace) {
    const epoch = this.generation,
      account = this.account(),
      docs: StoredDocument[] = [];
    let cursor: string | undefined;
    do {
      this.guard(epoch, account);
      const page = await this.list(namespace, cursor);
      this.guard(epoch, account);
      docs.push(...page.documents);
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return docs;
  }
  async put(
    namespace: Namespace,
    id: string,
    value: unknown,
    expectedRevision: number,
    occurredAt?: string,
    merge?: (remote: unknown, local: unknown) => unknown,
    product: Product = this.products.length === 1
      ? this.products[0]
      : value && typeof value === 'object' && 'transactions' in value
        ? 'bank-subcaps'
        : 'portfolio',
  ): Promise<StoredDocument> {
    if (!this.key) throw new Error('Unlock first');
    if (
      !this.products.includes(product) ||
      !this.me?.products.includes(product) ||
      !this.me.namespaces.includes(namespace)
    )
      throw new ApiFailure(403, 'scope');
    idSchema.parse(id);
    namespaceSchema.parse(namespace);
    validateProductDocument(product, namespace, value, occurredAt);
    if (namespace === 'history' && (!occurredAt || !Number.isFinite(Date.parse(occurredAt))))
      throw new Error('History requires a valid occurredAt');
    if (namespace === 'history' && new Date(occurredAt!) < calendarCutoff())
      throw new ApiFailure(410, 'history_expired');
    if (namespace === 'settings' && occurredAt !== undefined)
      throw new Error('Settings cannot have occurredAt');
    if (namespace === 'history' && value && typeof value === 'object' && 'transactions' in value) {
      const capture = value as { persistence?: string; provenance?: { flags?: string[] } };
      if (
        product !== 'bank-subcaps' ||
        capture.persistence !== 'account-bound' ||
        capture.provenance?.flags?.includes('ACCOUNT_CONTEXT_UNAVAILABLE') ||
        capture.provenance?.flags?.includes('EPHEMERAL_ONLY')
      )
        throw new Error(
          'Ephemeral card captures require explicit account binding before persistence',
        );
    }
    const epoch = this.generation,
      account = this.account(),
      key = this.key,
      context = this.context(namespace, id),
      check = () => this.guard(epoch, account),
      queueKey = `mutation:${account}:${namespace}:${id}`;
    const digest = await fingerprint({ product, expectedRevision, occurredAt: occurredAt ?? null });
    check();
    type Pending = {
      fingerprint: string;
      body: {
        product: Product;
        expectedRevision: number;
        mutationId: string;
        envelope: EncryptedEnvelope;
        occurredAt?: string;
      };
    };
    const pointer = await this.storage.get<Partial<Pending> & { receiptKey?: string }>(queueKey);
    check();
    const keys = this.storage.keys ? await this.storage.keys() : [];
    check();
    const candidates = [
      ...new Set([
        ...(pointer?.body ? [queueKey] : []),
        ...(pointer?.receiptKey ? [pointer.receiptKey] : []),
        ...keys.filter((key) => key.startsWith(`${queueKey}:`)),
      ]),
    ];
    let pending: Pending | undefined,
      receiptKey = '';
    for (const candidateKey of candidates) {
      const candidate = await this.storage.get<Pending>(candidateKey);
      check();
      if (candidate?.fingerprint !== digest) continue;
      let samePayload = false;
      try {
        const queued = await decryptJson(key, candidate.body.envelope, context);
        check();
        validateProductDocument(product, namespace, queued, candidate.body.occurredAt);
        samePayload = canonical(queued) === canonical(value);
      } catch {
        /* Changed key or queue format: do not replay a mismatched envelope. */
      }
      check();
      if (samePayload) {
        pending = candidate;
        receiptKey = candidateKey;
        break;
      }
    }
    if (!pending) {
      const envelope = await encryptJson(key, value, context);
      check();
      pending = {
        fingerprint: digest,
        body: {
          product,
          expectedRevision,
          mutationId: crypto.randomUUID(),
          envelope,
          ...(occurredAt ? { occurredAt } : {}),
        },
      };
      documentPutRequestSchema.parse(pending.body);
      checkBodySize(pending.body);
      receiptKey = `${queueKey}:${pending.body.mutationId}`;
      const saved = pending;
      await this.stored(async () => {
        await this.storage.set(receiptKey, saved);
        check();
        await this.storage.set(queueKey, { receiptKey, ...(occurredAt ? { occurredAt } : {}) });
      }, check);
    }
    const clearReceipt = () =>
      this.stored(async () => {
        await this.storage.delete(receiptKey);
        check();
        if (receiptKey !== queueKey) {
          const current = await this.storage.get<{ receiptKey?: string }>(queueKey);
          check();
          if (current?.receiptKey === receiptKey) await this.storage.delete(queueKey);
        }
      }, check);
    check();
    try {
      const result = await this.request<StoredDocument>(
        `/documents/${namespace}/${id}`,
        'PUT',
        pending.body,
      );
      check();
      await clearReceipt();
      return result;
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 409 || !merge) throw error;
      const remote = await this.request<StoredDocument>(`/documents/${namespace}/${id}`);
      const decoded = await this.decrypt(remote);
      check();
      const merged = merge(decoded, value);
      await clearReceipt();
      if (canonical(merged) === canonical(decoded)) return remote;
      return this.put(namespace, id, merged, remote.revision, occurredAt, undefined, product);
    }
  }
  async encryptedExport() {
    return this.request<ExportResponse>('/export');
  }
  async decryptedExport() {
    const epoch = this.generation,
      accountId = this.account();
    const namespaces = [...new Set(this.me?.namespaces ?? [])];
    const documents = (
      await Promise.all(namespaces.map((namespace) => this.all(namespace)))
    ).flat();
    this.guard(epoch, accountId);
    const decoded = await Promise.all(
      documents.map(async (doc) => ({
        namespace: doc.namespace,
        product: (doc as StoredDocument & { product?: Product }).product,
        id: doc.id,
        ...(doc.occurredAt ? { occurredAt: doc.occurredAt } : {}),
        value: await this.decrypt(doc),
      })),
    );
    this.guard(epoch, accountId);
    return {
      format: 'finance-tools-decrypted',
      version: 1,
      accountId,
      exportedAt: new Date().toISOString(),
      documents: decoded,
    };
  }
  async importDecrypted(input: unknown) {
    if (!this.key) throw new Error('Unlock before importing');
    const epoch = this.generation,
      account = this.account(),
      check = () => this.guard(epoch, account);
    const file = input as {
      format?: unknown;
      version?: unknown;
      accountId?: unknown;
      exportedAt?: unknown;
      documents?: unknown;
    };
    if (
      !file ||
      file.format !== 'finance-tools-decrypted' ||
      file.version !== 1 ||
      typeof file.accountId !== 'string' ||
      typeof file.exportedAt !== 'string' ||
      !Array.isArray(file.documents) ||
      file.documents.length > 10000
    )
      throw new Error('Invalid fresh decrypted export format');
    validateJson(file);
    timestampSchema.parse(file.exportedAt);
    idSchema.parse(file.accountId);
    if (new TextEncoder().encode(JSON.stringify(file)).byteLength > 64 * 1024 * 1024)
      throw new Error('Maximum import size is 64 MiB');
    const identities = new Set<string>();
    for (const item of file.documents) {
      if (!item || typeof item !== 'object') throw new Error('Invalid import document');
      const doc = item as {
        namespace: Namespace;
        product: Product;
        id: string;
        value: unknown;
        occurredAt?: string;
      };
      namespaceSchema.parse(doc.namespace);
      idSchema.parse(doc.id);
      const identity = `${doc.namespace}:${doc.id}`;
      if (identities.has(identity)) throw new Error('Duplicate import document');
      identities.add(identity);
      validateProductDocument(doc.product, doc.namespace, doc.value, doc.occurredAt);
      // Preflight all document plaintext limits before the first encryption/write.
      if (new TextEncoder().encode(JSON.stringify(doc.value)).byteLength > 800000)
        throw new Error('Import document exceeds encrypted request size budget');
      if (
        !this.products.includes(doc.product) ||
        !this.me?.namespaces.includes(doc.namespace) ||
        (doc.namespace === 'history'
          ? typeof doc.occurredAt !== 'string' || !Number.isFinite(Date.parse(doc.occurredAt))
          : doc.occurredAt !== undefined)
      )
        throw new Error('Invalid import metadata or scope');
      if (doc.occurredAt && !doc.occurredAt.endsWith('Z'))
        throw new Error('History import requires UTC wire timestamps');
    }
    for (const item of file.documents) {
      check();
      const doc = item as {
        namespace: Namespace;
        product: Product;
        id: string;
        value: unknown;
        occurredAt?: string;
      };
      const namespace = namespaceSchema.parse(doc.namespace);
      idSchema.parse(doc.id);
      if (
        namespace === 'history' &&
        (!doc.occurredAt ||
          !Number.isFinite(Date.parse(doc.occurredAt)) ||
          new Date(doc.occurredAt) < calendarCutoff())
      )
        continue;
      const id = `import_${await fingerprint([file.accountId, file.exportedAt, namespace, doc.id])}`;
      check();
      await this.put(
        namespace,
        id,
        doc.value,
        0,
        namespace === 'history' ? doc.occurredAt : undefined,
        (remote, local) => {
          if (canonical(remote) !== canonical(local))
            throw new Error('Import differs from an earlier import; nothing was overwritten');
          return remote;
        },
        doc.product,
      );
    }
  }
  // Preflight and authenticate every ciphertext before the first mutation. Interrupted restores resume only the exact backup.
  async restore(input: ExportResponse, credential: string, recovery = false) {
    const epoch = this.generation,
      account = this.account(),
      check = () => this.guard(epoch, account);
    if (
      !input ||
      input.version !== 1 ||
      input.accountId !== account ||
      !input.vault ||
      !Array.isArray(input.documents) ||
      input.documents.length > 10000 ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > 64 * 1024 * 1024
    )
      throw new Error('Invalid same-account encrypted export (maximum 64 MiB)');
    const validTime = (value: unknown) =>
      typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
    if (!validTime(input.exportedAt)) throw new Error('Invalid export timestamp');
    if (!Number.isSafeInteger(input.vault.revision) || input.vault.revision < 1)
      throw new Error('Invalid vault revision');
    const vault = vaultSchema.parse(input.vault.vault),
      identities = new Set<string>();
    for (const doc of input.documents) {
      idSchema.parse(doc.id);
      namespaceSchema.parse(doc.namespace);
      encryptedEnvelopeSchema.parse(doc.envelope);
      const product = (doc as StoredDocument & { product: Product }).product;
      if (
        !this.products.includes(product) ||
        doc.envelope.keyVersion !== vault.keyVersion ||
        !validTime(doc.updatedAt) ||
        !Number.isSafeInteger(doc.revision) ||
        doc.revision < 1 ||
        (doc.namespace === 'history' ? !validTime(doc.occurredAt) : doc.occurredAt !== undefined)
      )
        throw new Error('Invalid document metadata or product');
      const id = `${doc.namespace}:${doc.id}`;
      if (identities.has(id)) throw new Error('Duplicate export document');
      identities.add(id);
      checkBodySize({
        expectedRevision: 0,
        mutationId: '00000000-0000-4000-8000-000000000000',
        product,
        envelope: doc.envelope,
        ...(doc.namespace === 'history' ? { occurredAt: doc.occurredAt } : {}),
      });
    }
    const importedKey = await (recovery
      ? recoverVault(account, vault, credential)
      : unlockVault(account, vault, credential));
    check();
    for (const doc of input.documents) {
      const value = await decryptJson(importedKey, doc.envelope, {
        accountId: account,
        namespace: doc.namespace,
        documentId: doc.id,
        schemaVersion: 1,
        keyVersion: vault.keyVersion,
      });
      check();
      validateProductDocument(doc.product, doc.namespace, value, doc.occurredAt);
    }
    const digest = await fingerprint(input);
    check();
    const resumeKey = `restore:${account}`;
    const resume = await this.storage.get<{ digest: string }>(resumeKey);
    check();
    let current: VaultResponse | undefined;
    try {
      current = await this.request<VaultResponse>('/vault');
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
    }
    check();
    if (current && (resume?.digest !== digest || canonical(current.vault) !== canonical(vault)))
      throw new Error('Restore requires an empty vault, or resumption of this exact backup');
    const existing = [...(await this.all('settings')), ...(await this.all('history'))];
    check();
    const retained = input.documents.filter(
      (doc) => doc.namespace !== 'history' || new Date(doc.occurredAt!) >= calendarCutoff(),
    );
    const byId = new Map(retained.map((doc) => [`${doc.namespace}:${doc.id}`, doc]));
    for (const doc of existing) {
      const backup = byId.get(`${doc.namespace}:${doc.id}`);
      if (
        !current ||
        !backup ||
        canonical(doc.envelope) !== canonical(backup.envelope) ||
        (doc as StoredDocument & { product: Product }).product !==
          (backup as StoredDocument & { product: Product }).product
      )
        throw new Error('Existing documents differ from the resumable backup');
    }
    await this.stored(() => this.storage.set(resumeKey, { digest }), check);
    const restoredVault =
      current ?? (await this.mutation<VaultResponse>('/vault', { expectedRevision: 0, vault }));
    check();
    this.vault = restoredVault;
    const completed = new Set(existing.map((doc) => `${doc.namespace}:${doc.id}`));
    for (const doc of retained) {
      check();
      if (completed.has(`${doc.namespace}:${doc.id}`)) continue;
      await this.mutation(`/documents/${doc.namespace}/${doc.id}`, {
        product: (doc as StoredDocument & { product: Product }).product,
        expectedRevision: 0,
        envelope: doc.envelope,
        ...(doc.namespace === 'history' ? { occurredAt: doc.occurredAt } : {}),
      });
      check();
    }
    const verified = [...(await this.all('settings')), ...(await this.all('history'))];
    check();
    const verifiedById = new Map(verified.map((doc) => [`${doc.namespace}:${doc.id}`, doc]));
    for (const doc of retained) {
      if (doc.namespace === 'history' && new Date(doc.occurredAt!) < calendarCutoff()) continue;
      const current = verifiedById.get(`${doc.namespace}:${doc.id}`);
      if (
        !current ||
        current.product !== doc.product ||
        canonical(current.envelope) !== canonical(doc.envelope)
      )
        throw new Error(
          'Restore changed concurrently. Review and retry; no divergent document was overwritten.',
        );
    }
    await this.stored(() => this.storage.delete(resumeKey), check);
    check();
    this.key = importedKey;
  }
}

export async function browserCoordinator<T>(
  task: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  if (!navigator.locks) throw new Error('This browser needs Web Locks for safe session renewal');
  return await navigator.locks.request('finance-session-refresh', () => task(() => {}));
}
export const indexedStorage: Storage = {
  async get<T>(key: string) {
    return database('readonly', (store) => store.get(key)) as Promise<T | undefined>;
  },
  async set(key, value) {
    await database('readwrite', (store) => store.put(value, key));
  },
  async delete(key) {
    await database('readwrite', (store) => store.delete(key));
  },
  async keys() {
    return ((await database('readonly', (store) => store.getAllKeys())) as IDBValidKey[]).filter(
      (key): key is string => typeof key === 'string',
    );
  },
};
function database(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('finance-tools', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('private');
    open.onerror = () => reject(new Error('Private storage unavailable'));
    open.onsuccess = () => {
      const db = open.result,
        tx = db.transaction('private', mode),
        req = action(tx.objectStore('private'));
      tx.oncomplete = () => {
        resolve(req.result);
        db.close();
      };
      tx.onerror = () => {
        reject(new Error('Private storage failed'));
        db.close();
      };
    };
  });
}
export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
