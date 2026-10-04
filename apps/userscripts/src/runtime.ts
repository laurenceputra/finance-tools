import {
  API,
  FinanceClient,
  calendarCutoff,
  download,
  mergeSettings,
  mergeSnapshots,
  previewLegacyConfig,
} from '@finance-tools/client';
import type { Storage, Transport } from '@finance-tools/client';
import type { PairingResponse, StoredDocument } from '@finance-tools/contracts';
import { bindCardCapture } from '@finance-tools/provider-adapters';
import type { CardCapture, PortfolioSnapshot } from '@finance-tools/provider-adapters';
import {
  addMinor,
  aggregateCardHistory,
  calculateAllocations,
  parseAllocationSettings,
  parseCardCapture,
  parseCardSettings,
  parsePortfolioSnapshot,
  partitionCardCaptureByPostingDate,
  retainThreeMonths,
} from '@finance-tools/portfolio-domain';
import { evaluateMonthly, resolveCategory } from '@finance-tools/card-rules';
import type { CardSettings } from '@finance-tools/card-rules';
import { CaptureStore } from './capture-store';
type Capture = PortfolioSnapshot | CardCapture;
function ruleSettings(value: unknown): CardSettings {
  return parseCardSettings(value);
}
function isCapture(value: unknown): value is Capture {
  try {
    if (value && typeof value === 'object' && 'transactions' in value) parseCardCapture(value);
    else parsePortfolioSnapshot(value);
    return true;
  } catch {
    return false;
  }
}
const storage: Storage = {
  async get<T>(key: string) {
    return GM_getValue<T | undefined>(`finance:${key}`);
  },
  async set(key, value) {
    GM_setValue(`finance:${key}`, value);
  },
  async delete(key) {
    GM_deleteValue(`finance:${key}`);
  },
  async keys() {
    return GM_listValues()
      .filter((key) => key.startsWith('finance:'))
      .map((key) => key.slice(8));
  },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Lamport bakery tickets + bounded leases: GM storage has no compare-and-swap.
// Each tab owns its unique record; lexicographic ticket order serializes cross-host refresh.
async function coordinate<T>(task: (assertOwned: () => void) => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID(),
    key = `finance:lease:${owner}`,
    expires = Date.now() + 30_000;
  type Ticket = { choosing: boolean; ticket: number; expires: number };
  const live = () =>
    GM_listValues()
      .filter((k) => k.startsWith('finance:lease:'))
      .map((k) => ({ key: k, value: GM_getValue<Ticket>(k) }))
      .filter((x) => x.value && x.value.expires > Date.now());
  GM_setValue(key, { choosing: true, ticket: 0, expires });
  const ticket = 1 + Math.max(0, ...live().map((x) => x.value.ticket));
  GM_setValue(key, { choosing: false, ticket, expires });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const ownerKey = 'finance:refresh-owner';
  const assertOwned = () => {
    const own = GM_getValue<Ticket>(key),
      current = GM_getValue<{ key: string; ticket: number; expires: number }>(ownerKey);
    if (
      !own ||
      own.ticket !== ticket ||
      own.choosing ||
      own.expires <= Date.now() ||
      current?.key !== key ||
      current.ticket !== ticket ||
      current.expires <= Date.now()
    )
      throw new Error('Renewal lease lost; retry the persisted attempt');
  };
  try {
    while (true) {
      if (Date.now() > expires - 15_000)
        throw new Error('Another tab is renewing the session. Retry shortly.');
      const waiting = live().some(
        (x) =>
          x.key !== key &&
          (x.value.choosing ||
            x.value.ticket < ticket ||
            (x.value.ticket === ticket && x.key < key)),
      );
      if (!waiting) break;
      await sleep(80);
    }
    const previous = GM_getValue<{ key: string; expires: number }>(ownerKey);
    if (previous && previous.key !== key && previous.expires > Date.now())
      throw new Error('Refresh ownership contention. Retry without disconnecting.');
    GM_setValue(ownerKey, { key, ticket, expires });
    await sleep(80);
    assertOwned();
    heartbeat = setInterval(() => {
      try {
        assertOwned();
        const renewed = Date.now() + 30_000;
        GM_setValue(key, { choosing: false, ticket, expires: renewed });
        GM_setValue(ownerKey, { key, ticket, expires: renewed });
      } catch {
        if (heartbeat) clearInterval(heartbeat);
      }
    }, 3000);
    const result = await task(assertOwned);
    assertOwned();
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    const own = GM_getValue<Ticket>(key);
    if (own?.ticket === ticket) GM_deleteValue(key);
    if (GM_getValue<{ key: string }>(ownerKey)?.key === key) GM_deleteValue(ownerKey);
  }
}
const transport: Transport = (path, method, body, token, headers) =>
  new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      url: API + path,
      method,
      anonymous: true,
      timeout: 12_000,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
      onload: (response) => {
        try {
          resolve({
            status: response.status,
            body: response.status === 204 ? undefined : JSON.parse(response.responseText),
          });
        } catch {
          reject(new Error('Invalid server response'));
        }
      },
      onerror: () => reject(new Error('Network unavailable. No data was discarded.')),
      ontimeout: () => reject(new Error('Request timed out. Retry safely.')),
    });
  });
export function runtime(name: string) {
  const product = name === 'portfolio' ? 'portfolio' : 'bank-subcaps';
  const settingsId = `current_${product}`;
  const client = new FinanceClient(transport, storage, 'userscript', coordinate, [product]);
  let captures: Capture[] = [],
    settings: Record<string, unknown> = {},
    settingRevision = 0,
    pairing: PairingResponse | undefined;
  const captureStore = new CaptureStore<Capture>();
  const refreshCaptures = () => {
    captures = captureStore.values;
  };
  let autoSync = false,
    syncTimer: ReturnType<typeof setTimeout> | undefined,
    syncFlight: Promise<void> | undefined;
  async function syncCaptured() {
    if (syncFlight) return syncFlight;
    const epoch = client.lockEpoch,
      account = client.me?.accountId;
    syncFlight = (async () => {
      await purge();
      if (!client.unlocked) throw new Error('Unlock first');
      for (const capture of captureStore.dirty) {
        if ('transactions' in capture && capture.persistence !== 'account-bound') continue;
        if (client.lockEpoch !== epoch || client.me?.accountId !== account) return;
        const partitions =
          'transactions' in capture
            ? await partitionCardCaptureByPostingDate(capture)
            : [{ capture, occurredAt: capture.provenance.capturedAt }];
        for (const partition of partitions) {
          if (new Date(partition.occurredAt) < calendarCutoff()) continue;
          const doc = await client.put(
            'history',
            partition.capture.id,
            partition.capture,
            0,
            partition.occurredAt,
            mergeSnapshots,
          );
          if (client.lockEpoch !== epoch || client.me?.accountId !== account) return;
          GM_setValue(`finance:cache:${account}:${doc.id}`, doc);
        }
        captureStore.synced(capture);
      }
      render();
      if (
        captureStore.dirty.some(
          (value) => !('transactions' in value) || value.persistence === 'account-bound',
        )
      )
        scheduleSync();
    })().finally(() => {
      syncFlight = undefined;
    });
    return syncFlight;
  }
  function scheduleSync() {
    if (!autoSync || !client.unlocked) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void run(syncCaptured);
    }, 1500);
  }
  const lockListeners: (() => void)[] = [];
  const unlockListeners: (() => void)[] = [];
  let captureWarning = '';
  let remoteLock = false;
  GM_addValueChangeListener('finance:lock-event', (_key, _old, _next, remote) => {
    if (!remote) return;
    remoteLock = true;
    void client.lock().finally(() => {
      remoteLock = false;
    });
  });
  let host: HTMLElement, panel: HTMLElement, status: HTMLElement, output: HTMLElement;
  const clear = (propagate = true) => {
    if (syncTimer) clearTimeout(syncTimer);
    autoSync = false;
    captureStore.clear();
    refreshCaptures();
    settings = {};
    settingRevision = 0;
    for (const listener of lockListeners) listener();
    if (output) output.replaceChildren();
    if (!remoteLock && propagate) GM_setValue('finance:lock-event', crypto.randomUUID());
  };
  client.onLock = clear;
  async function purge() {
    await client.purgeLocalHistory();
    for (const key of GM_listValues().filter((k) => k.startsWith('finance:cache:'))) {
      const doc = GM_getValue<StoredDocument>(key);
      if (!doc?.occurredAt || new Date(doc.occurredAt) < calendarCutoff()) GM_deleteValue(key);
    }
    captureStore.retain((x) => {
      if ('transactions' in x)
        x.transactions = retainThreeMonths(x.transactions, new Date().toISOString());
      return (
        new Date(x.provenance.capturedAt) >= calendarCutoff() &&
        (!('transactions' in x) || x.transactions.length > 0)
      );
    });
    refreshCaptures();
  }
  const text = (tag: string, value: string, parent = panel) => {
    const el = document.createElement(tag);
    el.textContent = value;
    parent.append(el);
    return el;
  };
  function notify(message: string) {
    if (status) status.textContent = message;
  }
  async function run(task: () => Promise<void>) {
    notify('Working…');
    try {
      await task();
      notify(
        `${client.me ? 'Connected' : 'Disconnected'} · ${client.unlocked ? 'Unlocked' : 'Locked'}`,
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Operation failed');
    }
  }
  function button(label: string, action: () => Promise<void>) {
    const btn = text('button', label) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void run(action).finally(() => {
        btn.disabled = false;
      });
    });
    return btn;
  }
  async function loadSettings() {
    const epoch = client.lockEpoch;
    const docs = await client.all('settings');
    const current = docs.find((x) => x.id === settingsId);
    const next = current ? await client.decrypt<Record<string, unknown>>(current) : {};
    if (client.lockEpoch !== epoch || !client.unlocked) return;
    settings = next;
    settingRevision = current?.revision ?? 0;
  }
  async function importCache(file: File) {
    const epoch = client.lockEpoch,
      account = client.me?.accountId;
    if (!account || !client.unlocked) throw new Error('Connect and unlock before importing');
    if (file.size > 64 * 1024 * 1024)
      throw new Error(
        'Maximum encrypted cache size is 64 MiB; larger files require streaming tooling',
      );
    const input = JSON.parse(await file.text()) as {
      format: string;
      version: number;
      accountId: string;
      documents: StoredDocument[];
    };
    if (client.lockEpoch !== epoch) return;
    if (
      input.format !== 'finance-tools-script-cache' ||
      input.version !== 1 ||
      input.accountId !== account ||
      !Array.isArray(input.documents)
    )
      throw new Error('Not a same-account script cache');
    const decoded: Capture[] = [],
      validDocs: StoredDocument[] = [],
      ids = new Set<string>();
    for (const doc of input.documents) {
      if (
        doc.namespace !== 'history' ||
        doc.product !== product ||
        !doc.occurredAt ||
        !Number.isFinite(Date.parse(doc.occurredAt)) ||
        !doc.occurredAt.endsWith('Z') ||
        !Number.isSafeInteger(doc.revision) ||
        doc.revision < 1
      )
        throw new Error('Invalid encrypted cache metadata');
      if (ids.has(doc.id)) throw new Error('Duplicate cache document');
      ids.add(doc.id);
      const capture = await client.decrypt(doc);
      if (
        !isCapture(capture) ||
        ('transactions' in capture &&
          (capture.persistence !== 'account-bound' ||
            capture.provenance.flags.includes('ACCOUNT_CONTEXT_UNAVAILABLE')))
      )
        throw new Error('Unsupported or ephemeral snapshot format');
      if (client.lockEpoch !== epoch || client.me?.accountId !== account) return;
      if (new Date(doc.occurredAt) < calendarCutoff()) continue;
      decoded.push(capture);
      validDocs.push(doc);
    }
    for (const doc of validDocs) {
      if (client.lockEpoch !== epoch || client.me?.accountId !== account) return;
      GM_setValue(`finance:cache:${account}:${doc.id}`, doc);
    }
    if (client.lockEpoch !== epoch || !client.unlocked) return;
    captureStore.add(decoded, false);
    refreshCaptures();
    render();
  }
  function render() {
    if (!output) return;
    output.replaceChildren();
    if (captureWarning) text('p', captureWarning, output);
    if (!client.unlocked) {
      text(
        'p',
        'Unlock to view or sync. A bounded startup-only capture queue lives in memory for at most 30 seconds; it is never persisted and explicit lock/navigation discards it.',
        output,
      );
      return;
    }
    text(
      'p',
      `${captureStore.dirty.length} unsynced captures. Pull merges without discarding them. Memory is limited to 10,000 captures; excess batches are rejected, never truncated. Export/sync before navigating away or locking.`,
      output,
    );
    try {
      for (const result of calculateAllocations(
        captures.filter((value): value is PortfolioSnapshot => 'holdings' in value),
        parseAllocationSettings(settings.allocations ?? { scopes: [] }),
      )) {
        const box = document.createElement('section');
        output.append(box);
        text(
          'h3',
          `${result.scope.bucket} · ${result.scope.accountType} / ${result.scope.currency} / ${result.scope.section}`,
          box,
        );
        text(
          'p',
          `Actual ${(result.actualTotalMinor / 100).toFixed(2)} · projected ${(result.projectedTotalMinor / 100).toFixed(2)} · ${result.warnings.join(', ')}`,
          box,
        );
        for (const row of result.rows)
          text(
            'p',
            `${row.holdingId}: actual ${row.actualMinor === null ? 'unknown' : (row.actualMinor / 100).toFixed(2)} · target ${row.targetMinor === null ? 'unknown' : (row.targetMinor / 100).toFixed(2)} · drift ${row.driftBps ?? 'unknown'} bps · target−actual ${row.deltaMinor === null ? 'unknown' : (row.deltaMinor / 100).toFixed(2)} ${row.fixed ? 'FIXED' : ''} ${row.excluded ? 'EXCLUDED' : ''}`,
            box,
          );
      }
    } catch {
      text(
        'p',
        'Allocation settings/source are invalid. Target/drift calculations are unavailable.',
        output,
      );
    }
    const latest = new Map<string, Capture>();
    for (const capture of captures) {
      const id =
          'transactions' in capture && capture.persistence !== 'account-bound'
            ? capture.id
            : `${capture.provenance.provider}:${capture.accountId}`,
        old = latest.get(id);
      if (!old || old.provenance.capturedAt < capture.provenance.capturedAt)
        latest.set(id, capture);
    }
    const assign = (
      id: string,
      box: HTMLElement,
      bank?: { capture: CardCapture; merchant: string },
    ) => {
      const btn = text(
        'button',
        bank ? 'Map merchant category for reference rules' : 'Assign category',
        box,
      ) as HTMLButtonElement;
      btn.addEventListener('click', () => {
        const category = prompt('Category (user-assigned, not issuer eligibility):');
        if (category === null) return;
        void run(async () => {
          const epoch = client.lockEpoch,
            base = settings,
            assignments =
              base.assignments && typeof base.assignments === 'object'
                ? (base.assignments as Record<string, unknown>)
                : {};
          if (bank && bank.capture.persistence !== 'account-bound')
            throw new Error('Bind this account before saving merchant categorization');
          const cards =
              base.cards && typeof base.cards === 'object'
                ? (base.cards as Record<string, CardSettings>)
                : {},
            config = bank
              ? (cards[bank.capture.accountId] ?? { selectedCategories: [] })
              : undefined;
          const value = bank
            ? {
                ...base,
                cards: {
                  ...cards,
                  [bank.capture.accountId]: {
                    ...config,
                    merchantMap: {
                      ...config?.merchantMap,
                      [bank.merchant.replace(/[\\*]/g, '\\$&')]: category.trim(),
                    },
                  },
                },
              }
            : { ...base, assignments: { ...assignments, [id]: category.trim() } };
          const doc = await client.put(
            'settings',
            settingsId,
            value,
            settingRevision,
            undefined,
            (remote, local) => mergeSettings(base, remote, local),
          );
          const next = await client.decrypt<Record<string, unknown>>(doc);
          if (client.lockEpoch !== epoch || !client.unlocked) return;
          settings = next;
          settingRevision = doc.revision;
          render();
        });
      });
    };
    for (const capture of latest.values()) {
      const box = document.createElement('section');
      output.append(box);
      text('h3', `${capture.provenance.provider} · ${capture.provenance.capturedAt}`, box);
      text(
        'p',
        `Incomplete capture · ${capture.provenance.source} · ${capture.provenance.flags.join(', ') || 'No additional flags'}`,
        box,
      );
      if (Date.now() - Date.parse(capture.provenance.capturedAt) > 86400000)
        text('p', 'Stale: captured more than one day ago.', box);
      if (
        'transactions' in capture &&
        (capture.persistence !== 'account-bound' ||
          capture.provenance.flags.includes('ACCOUNT_CONTEXT_UNAVAILABLE'))
      ) {
        text(
          'p',
          'Ephemeral only: no trustworthy account context. This capture cannot sync or export until explicitly bound to a masked account. Never reuse a binding for a different card account.',
          box,
        );
        const bind = text(
          'button',
          'Bind this capture to a masked account',
          box,
        ) as HTMLButtonElement;
        const discard = text('button', 'Discard ephemeral capture', box) as HTMLButtonElement;
        discard.onclick = () => {
          captureStore.remove(capture.id);
          refreshCaptures();
          render();
        };
        bind.onclick = () => {
          const explicitId = prompt(
            'Enter a unique masked account label, e.g. ****1234. Confirm this visible table belongs to that account.',
          );
          if (!explicitId) return;
          void run(async () => {
            if (!/^[A-Za-z0-9 *._-]{4,80}$/.test(explicitId) || !explicitId.includes('*'))
              throw new Error(
                'Use a masked account label containing *; never enter a full account number',
              );
            const epoch = client.lockEpoch,
              account = client.me?.accountId,
              base = settings;
            const bound = await bindCardCapture(capture, explicitId);
            if (client.lockEpoch !== epoch || !client.unlocked || client.me?.accountId !== account)
              return;
            const bindings =
              base.bankBindings && typeof base.bankBindings === 'object'
                ? (base.bankBindings as Record<string, unknown>)
                : {};
            const value = {
              ...base,
              bankBindings: {
                ...bindings,
                [bound.accountId]: {
                  provider: capture.provenance.provider,
                  card: capture.card,
                  maskedAccount: explicitId,
                },
              },
            };
            const doc = await client.put(
              'settings',
              settingsId,
              value,
              settingRevision,
              undefined,
              (remote, local) => mergeSettings(base, remote, local),
            );
            const next = await client.decrypt<Record<string, unknown>>(doc);
            if (client.lockEpoch !== epoch || !client.unlocked) return;
            settings = next;
            settingRevision = doc.revision;
            captureStore.remove(capture.id);
            captureStore.add([bound]);
            refreshCaptures();
            render();
          });
        };
      }
      const assignment =
        settings.assignments && typeof settings.assignments === 'object'
          ? (settings.assignments as Record<string, unknown>)
          : {};
      const totals = new Map<string, number>(),
        unsafe = new Set<string>();
      const addTotal = (key: string, minor: number) => {
        if (unsafe.has(key)) return;
        try {
          totals.set(key, addMinor(totals.get(key) ?? 0, minor));
        } catch {
          totals.delete(key);
          unsafe.add(key);
        }
      };
      if ('holdings' in capture)
        for (const holding of capture.holdings) {
          const category =
            typeof assignment[holding.id] === 'string'
              ? (assignment[holding.id] as string)
              : 'Uncategorized';
          text(
            'p',
            `${holding.name || holding.code} · ${category} · ${holding.valuation ? `${holding.valuation.currency} ${(holding.valuation.minor / 100).toFixed(2)}` : 'Unknown valuation'} · ${holding.flags.join(', ')}`,
            box,
          );
          assign(holding.id, box);
          if (holding.valuation) {
            const key = `${category} / ${holding.valuation.currency} / ${holding.section}`;
            addTotal(key, holding.valuation.minor);
          }
        }
      else
        for (const transaction of capture.transactions) {
          const cards =
              settings.cards && typeof settings.cards === 'object'
                ? (settings.cards as Record<string, CardSettings>)
                : {},
            cardConfig = cards[capture.accountId] ?? { selectedCategories: [] };
          let category = 'Invalid rule settings';
          try {
            category = resolveCategory(
              transaction.merchant,
              ruleSettings(cardConfig),
              capture.card,
            );
          } catch {
            /* Show unavailable classification instead of crashing on decrypted JSON. */
          }
          text(
            'p',
            `${transaction.postingDate} · ${transaction.merchant} · ${category} · ${transaction.spending.currency} ${(transaction.spending.minor / 100).toFixed(2)}`,
            box,
          );
          assign(transaction.id, box, { capture, merchant: transaction.merchant });
          const key = `${transaction.postingDate.slice(0, 7)} / ${category} / ${transaction.spending.currency}`;
          addTotal(key, transaction.spending.minor);
        }
      if (unsafe.size)
        text('p', 'Some totals exceed safe integer precision and are unavailable.', box);
      for (const [key, total] of totals) {
        text('p', `${key}: ${(total / 100).toFixed(2)}`, box);
        if ('transactions' in capture)
          text(
            'p',
            'This is a captured window, not a complete month. Exact remaining is not claimed here; consult the retained-history reference results below and their ambiguity/partial-month warnings.',
            box,
          );
      }
    }
    const bound = captures.filter(
      (x): x is CardCapture =>
        'transactions' in x &&
        x.persistence === 'account-bound' &&
        !x.provenance.flags.includes('ACCOUNT_CONTEXT_UNAVAILABLE'),
    );
    let histories: ReturnType<typeof aggregateCardHistory> = [];
    try {
      histories = aggregateCardHistory(bound, new Date().toISOString());
    } catch {
      text(
        'p',
        'Invalid account-bound history. No potentially inaccurate aggregate is shown.',
        output,
      );
    }
    for (const history of histories) {
      const box = document.createElement('section');
      output.append(box);
      text('h3', `${history.card} · retained account history`, box);
      text(
        'p',
        `${history.captureIds.length} captures deduplicated by account + stable transaction ID. Coverage unknown; ${history.changes.length} corrections. Latest source ${history.provenance.capturedAt}. ${history.provenance.flags.join(', ')}`,
        box,
      );
      const cards =
        settings.cards && typeof settings.cards === 'object'
          ? (settings.cards as Record<string, CardSettings>)
          : {};
      let config: CardSettings = { selectedCategories: [] },
        valid = true;
      try {
        config = ruleSettings(cards[history.accountId] ?? config);
      } catch {
        valid = false;
        text(
          'p',
          'Invalid decrypted rule settings. Correct selectedCategories / merchantMap before calculating.',
          box,
        );
      }
      const edit = text(
        'button',
        'Configure selected categories / merchant map',
        box,
      ) as HTMLButtonElement;
      edit.onclick = () => {
        const input = prompt(
          'Reference-rule settings JSON: selectedCategories, defaultCategory, merchantMap',
          JSON.stringify(config),
        );
        if (input === null) return;
        void run(async () => {
          const epoch = client.lockEpoch,
            base = settings,
            nextConfig = ruleSettings(JSON.parse(input));
          const value = { ...base, cards: { ...cards, [history.accountId]: nextConfig } };
          const doc = await client.put(
            'settings',
            settingsId,
            value,
            settingRevision,
            undefined,
            (remote, local) => mergeSettings(base, remote, local),
          );
          const next = await client.decrypt<Record<string, unknown>>(doc);
          if (client.lockEpoch !== epoch || !client.unlocked) return;
          settings = next;
          settingRevision = doc.revision;
          render();
        });
      };
      try {
        if (!valid) throw new Error();
        for (const result of evaluateMonthly(
          history.card,
          history.transactions,
          config,
          new Date().toISOString(),
        )) {
          const ambiguous =
            history.totalsConfidence === 'latest-capture-lower-bound' ||
            history.ambiguousMonths.includes(result.month);
          text(
            'p',
            ambiguous
              ? `${result.month}: latest observed window SGD ${(result.totalMinor / 100).toFixed(2)} (lower bound / incomplete). Ambiguous identity: eligible and exact remaining are unknown.`
              : `${result.month}: total SGD ${(result.totalMinor / 100).toFixed(2)} · reference eligible SGD ${(result.eligibleMinor / 100).toFixed(2)} · remaining ${JSON.stringify(result.remainingMinor)}`,
            box,
          );
          text(
            'p',
            `${result.rule.status} reference rule ${result.rule.version}: ${result.rule.source}. Effective date unknown; verify with issuer.`,
            box,
          );
        }
      } catch {
        text(
          'p',
          'Rule calculation unavailable: invalid settings or non-SGD data. Review captured currencies and settings.',
          box,
        );
      }
      for (const row of history.transactions)
        text(
          'p',
          `${row.postingDate} · ${row.merchant} · ${valid ? resolveCategory(row.merchant, config, history.card) : 'Invalid settings'} · ${row.spending.currency} ${(row.spending.minor / 100).toFixed(2)}`,
          box,
        );
      for (const change of history.changes)
        text(
          'p',
          `Correction ${change.capturedAt}: ${change.transactionId} · ${change.previous.spending.minor / 100} → ${change.replacement.spending.minor / 100} ${change.replacement.spending.currency}`,
          box,
        );
    }
    if (!captures.length)
      text(
        'p',
        'No supported data captured yet. After unlocking, reload the portfolio route or capture the visible bank table.',
        output,
      );
  }
  async function mount() {
    host = document.createElement('div');
    host.id = `finance-${name}`;
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      ':host{all:initial;font-family:system-ui,sans-serif;position:fixed;right:12px;bottom:12px;z-index:2147483000;color:#19313f}details{background:#fff;border:1px solid #9ab2bf;border-radius:12px;box-shadow:0 8px 32px #0003;max-width:min(520px,92vw)}summary{padding:14px;cursor:pointer;font-weight:bold}main{padding:0 16px 16px;max-height:75vh;overflow:auto}button{padding:9px;margin:4px;border:1px solid #aac1ca;border-radius:6px;background:#edf5f6;cursor:pointer}input,textarea{display:block;width:95%;padding:8px;margin:6px 0}p{font-size:13px;line-height:1.5;overflow-wrap:anywhere}section{border-top:1px solid #ddd;padding:8px}a{color:#075365}';
    shadow.append(style);
    const details = document.createElement('details');
    shadow.append(details);
    text('summary', `Finance · ${name}`, details);
    panel = document.createElement('main');
    details.append(panel);
    status = text('p', 'Disconnected · Locked');
    status.setAttribute('role', 'status');
    text(
      'p',
      'Pairing grants encrypted sync only. Vault credentials stay in this script, never in the page bridge. Captures are incomplete and may be stale.',
    );
    const vaultLink = text(
      'a',
      'Create vault / download recovery / change passphrase in dashboard',
    ) as HTMLAnchorElement;
    vaultLink.href = 'https://finance.laurenceputra.com/';
    vaultLink.target = '_blank';
    vaultLink.rel = 'noopener noreferrer';
    button('Connect / create pairing', async () => {
      const epoch = client.lockEpoch;
      const created = await client.publicRequest<PairingResponse>('/pairing/create', {
        client: {
          kind: 'userscript',
          name: `Finance ${name}`,
          namespaces: ['settings', 'history'],
          products: [product],
        },
      });
      if (client.lockEpoch !== epoch) return;
      pairing = created;
      const link = text('a', 'Open dashboard to inspect and approve') as HTMLAnchorElement;
      link.href = `https://finance.laurenceputra.com/?pairingId=${encodeURIComponent(created.pairingId)}&code=${created.code}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      text(
        'p',
        `Pairing ID: ${created.pairingId} · Code: ${created.code} · Expires: ${created.expiresAt}`,
      );
    });
    button('Redeem approved pairing', async () => {
      if (!pairing) throw new Error('Create a pairing first');
      await client.redeem(pairing.pairingId, pairing.secret);
      pairing = undefined;
    });
    const credential = text('input', '') as HTMLInputElement;
    credential.type = 'password';
    credential.placeholder = 'Vault passphrase / recovery secret';
    credential.autocomplete = 'off';
    const recoveryLabel = text('label', 'Use recovery secret');
    const recovery = document.createElement('input');
    recovery.type = 'checkbox';
    recoveryLabel.append(recovery);
    const rememberLabel = text(
      'label',
      'Remember indefinitely (stores recovery key in GM; requires recovery unlock)',
    );
    const remember = document.createElement('input');
    remember.type = 'checkbox';
    rememberLabel.append(remember);
    button('Unlock', async () => {
      if (!client.me) await client.initialize();
      const secret = credential.value;
      credential.value = '';
      await client.unlock(secret, recovery.checked, remember.checked);
      await loadSettings();
      if (client.unlocked) for (const listener of unlockListeners) listener();
      render();
    });
    button('Lock & forget key', async () => {
      credential.value = '';
      await client.lock();
      render();
    });
    button('Disconnect', async () => {
      pairing = undefined;
      credential.value = '';
      await client.disconnect();
      for (const key of GM_listValues().filter((k) => k.startsWith('finance:cache:')))
        GM_deleteValue(key);
      render();
    });
    button('Sync captured snapshots', syncCaptured);
    const autoLabel = text(
      'label',
      'Opt in to background sync after capture/unlock (encrypted only; unidentified cards excluded)',
    );
    const auto = document.createElement('input');
    auto.type = 'checkbox';
    autoLabel.append(auto);
    auto.onchange = () => {
      void run(async () => {
        if (!client.me) throw new Error('Connect first');
        autoSync = auto.checked;
        GM_setValue(`finance:autosync:${client.me.accountId}`, autoSync);
        if (autoSync) scheduleSync();
        else if (syncTimer) clearTimeout(syncTimer);
      });
    };
    unlockListeners.push(() => {
      if (client.me) {
        autoSync = GM_getValue<boolean>(`finance:autosync:${client.me.accountId}`, false);
        auto.checked = autoSync;
        scheduleSync();
      }
    });
    button('Pull / decrypt history', async () => {
      const epoch = client.lockEpoch;
      await purge();
      const docs = await client.all('history');
      const next = await Promise.all(docs.map((doc) => client.decrypt(doc)));
      if (client.lockEpoch !== epoch || !client.unlocked) return;
      captureStore.add(next.filter(isCapture), false);
      refreshCaptures();
      await loadSettings();
      render();
    });
    button('Export decrypted data', async () => {
      if (!confirm('This export contains plaintext financial data. Save securely?')) return;
      download(`finance-${name}-decrypted.json`, await client.decryptedExport());
    });
    button('Export local bound captures (plaintext)', async () => {
      if (!client.unlocked || !client.me) throw new Error('Connect and unlock first');
      if (
        !confirm(
          'This plaintext file contains local financial captures/settings, including unsynced data. Unidentified cards are excluded. Store securely?',
        )
      )
        return;
      const epoch = client.lockEpoch,
        account = client.me.accountId,
        documents: unknown[] = [];
      if (client.me.namespaces.includes('history'))
        for (const capture of captures) {
          if ('transactions' in capture && capture.persistence !== 'account-bound') continue;
          const partitions =
            'transactions' in capture
              ? await partitionCardCaptureByPostingDate(capture)
              : [{ capture, occurredAt: capture.provenance.capturedAt }];
          if (epoch !== client.lockEpoch) return;
          for (const partition of partitions)
            if (new Date(partition.occurredAt) >= calendarCutoff())
              documents.push({
                namespace: 'history',
                product,
                id: partition.capture.id,
                occurredAt: partition.occurredAt,
                value: partition.capture,
              });
        }
      if (client.me?.namespaces.includes('settings'))
        documents.push({ namespace: 'settings', product, id: settingsId, value: settings });
      if (epoch !== client.lockEpoch || account !== client.me?.accountId) return;
      download(`finance-${name}-local-decrypted.json`, {
        format: 'finance-tools-decrypted',
        version: 1,
        accountId: account,
        exportedAt: new Date().toISOString(),
        documents,
      });
    });
    button('Export encrypted local snapshots', async () => {
      if (!client.me) throw new Error('Connect first');
      const docs = GM_listValues()
        .filter((k) => k.startsWith(`finance:cache:${client.me!.accountId}:`))
        .map((k) => GM_getValue<StoredDocument>(k));
      download(`finance-${name}-encrypted.json`, {
        format: 'finance-tools-script-cache',
        version: 1,
        accountId: client.me.accountId,
        documents: docs,
      });
    });
    const importInput = text('input', '') as HTMLInputElement;
    importInput.type = 'file';
    importInput.accept = 'application/json';
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (file) void run(() => importCache(file));
    });
    text('h3', 'Categorization / settings JSON');
    text(
      'p',
      'Set assignments as {"assignments":{"holding-or-transaction-id":"category"}}. Concurrent conflicts require reload and reconciliation. Settings never expire.',
    );
    if (product === 'portfolio')
      text(
        'p',
        'Actual target/drift settings: allocations.scopes[] with id, bucket, accountId, accountType (CPF/SRS/cash/unknown), currency, section, optional goalId/projectedDeposit, and targets keyed by holding ID: targetBps (0..10000) or targetAmount {minor,currency}, fixed or excluded. Balances/currencies/account types are not blended; unknown source coverage is flagged.',
      );
    if (product === 'portfolio')
      button('Edit validated allocation targets', async () => {
        const input = prompt(
          'Allocation settings JSON (scopes, account/currency/section, holding targets, fixed/excluded)',
          JSON.stringify(settings.allocations ?? { scopes: [] }),
        );
        if (input === null) return;
        const epoch = client.lockEpoch,
          base = settings;
        const value = { ...base, allocations: parseAllocationSettings(JSON.parse(input)) };
        const doc = await client.put(
          'settings',
          settingsId,
          value,
          settingRevision,
          undefined,
          (remote, local) => mergeSettings(base, remote, local),
        );
        const next = await client.decrypt<Record<string, unknown>>(doc);
        if (client.lockEpoch !== epoch) return;
        settings = next;
        settingRevision = doc.revision;
        render();
      });
    const editor = text('textarea', '{}') as HTMLTextAreaElement;
    editor.rows = 5;
    button('Load settings', async () => {
      await loadSettings();
      editor.value = JSON.stringify(settings, null, 2);
    });
    button('Save settings', async () => {
      const epoch = client.lockEpoch,
        base = settings;
      const value = JSON.parse(editor.value) as Record<string, unknown>;
      const doc = await client.put(
        'settings',
        settingsId,
        value,
        settingRevision,
        undefined,
        (remote, local) => mergeSettings(base, remote, local),
      );
      const next = await client.decrypt<Record<string, unknown>>(doc);
      if (client.lockEpoch !== epoch || !client.unlocked) return;
      settings = next;
      editor.value = JSON.stringify(next, null, 2);
      settingRevision = doc.revision;
      render();
    });
    text('h3', `Legacy local config import — explicit origin: ${product}`);
    text(
      'p',
      'Export decrypted configuration with the old tool first. No old remote login/email matching is attempted. Imported configurations are separate encrypted review documents; never overwrite current settings. Portfolio code/goal targets require explicit current allocation scopes.',
    );
    const legacy = text('input', '') as HTMLInputElement;
    legacy.type = 'file';
    legacy.accept = 'application/json';
    legacy.onchange = () => {
      const file = legacy.files?.[0];
      legacy.value = '';
      if (file)
        void run(async () => {
          if (file.size > 2 * 1024 * 1024) throw new Error('Legacy config maximum 2 MiB');
          const epoch = client.lockEpoch;
          const input = JSON.parse(await file.text());
          if (epoch !== client.lockEpoch) return;
          const mapping =
            product === 'bank-subcaps'
              ? (JSON.parse(
                  prompt(
                    'Explicit legacy card-name → current bound account ID mapping JSON ({} keeps unapplied templates)',
                    '{}',
                  ) ?? '{}',
                ) as Record<string, string>)
              : {};
          const preview = previewLegacyConfig(input, product, mapping);
          if (
            !confirm(`Import a separate ${product} review document? ${preview.warnings.join(', ')}`)
          )
            return;
          await client.put('settings', `legacy_${crypto.randomUUID()}`, preview.settings, 0);
          text('p', `Legacy review imported. ${preview.warnings.join(', ')}`);
        });
    };
    client.onLock = (propagate = true) => {
      clear(propagate);
      credential.value = '';
      editor.value = '{}';
      render();
    };
    output = text('div', '');
    render();
    GM_registerMenuCommand(`Open Finance ${name}`, () => {
      details.open = true;
    });
    try {
      await client.initialize();
      if (client.unlocked) {
        await loadSettings();
        for (const listener of unlockListeners) listener();
      }
      notify(
        `${client.me ? 'Connected' : 'Disconnected'} · ${client.unlocked ? 'Unlocked' : 'Locked'}`,
      );
    } catch {
      notify(
        'Session unavailable. Retry safely; transient failures do not remove keys or credentials.',
      );
    }
    await purge();
    render();
  }
  if (document.body) void mount();
  else document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
  return {
    client,
    onLock: (listener: () => void) => lockListeners.push(listener),
    onUnlock: (listener: () => void) => unlockListeners.push(listener),
    captureUnavailable: (warning: string) => {
      captureWarning = warning;
      render();
    },
    add: async (next: Capture[]) => {
      const epoch = client.lockEpoch;
      if (!client.unlocked) return;
      if (next.some((value) => !isCapture(value)))
        throw new Error('Captured product data failed complete domain validation');
      await purge();
      if (!client.unlocked || client.lockEpoch !== epoch) return;
      captureStore.add(next);
      refreshCaptures();
      render();
      scheduleSync();
    },
    button: (label: string, action: () => Promise<void>) => {
      const wait = () => {
        if (panel) button(label, action);
        else setTimeout(wait, 100);
      };
      wait();
    },
  };
}
