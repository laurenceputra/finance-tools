import { cardCaptureSchema } from './schemas';

export interface Money {
  minor: number;
  currency: string;
}
export interface Provenance {
  provider: string;
  capturedAt: string;
  source: string;
  complete: false;
  flags: string[];
}
export interface Holding {
  id: string;
  name: string;
  section: 'asset' | 'liability';
  code: string;
  subcode: string;
  valuation: Money | null;
  profit: Money | null;
  costBasis: Money | null;
  returnPercent: number | null;
  flags: string[];
  goalId?: string;
}
export type AccountType = 'CPF' | 'SRS' | 'cash' | 'unknown';
export interface PortfolioSnapshot {
  id: string;
  accountId: string;
  accountType?: AccountType;
  provenance: Provenance;
  holdings: Holding[];
}
export interface CardTransaction {
  id: string;
  identityKey?: string;
  identityConfidence?: 'provider-reference' | 'snapshot-local';
  reference: string;
  postingDate: string;
  transactionDate: string | null;
  merchant: string;
  spending: Money;
}
export interface CardCapture {
  id: string;
  observationId?: string;
  accountId: string;
  persistence: 'ephemeral' | 'account-bound';
  card: 'uob-lady-solitaire' | 'maybank-xl';
  provenance: Provenance;
  transactions: CardTransaction[];
}

/** Strict decimal conversion; never rounds or accepts unsafe integer minor units. */
export function minorUnits(input: unknown): number | null {
  if (input && typeof input === 'object') {
    const value = input as Record<string, unknown>;
    const display =
      value.display && typeof value.display === 'object'
        ? (value.display as Record<string, unknown>)
        : {};
    return (
      minorUnits(value.parsedValue) ??
      minorUnits(value.source) ??
      minorUnits(value.amount) ??
      minorUnits(display.amount)
    );
  }
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const text = String(input).trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  const clean = text.replaceAll(',', '');
  const [whole, fraction = ''] = clean.replace(/^[+-]/, '').split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const signed = clean.startsWith('-') ? -result : result;
  return signed <= BigInt(Number.MAX_SAFE_INTEGER) && signed >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(signed)
    : null;
}
export function money(value: unknown, currency: unknown): Money | null {
  const minor = minorUnits(value);
  return minor !== null && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
    ? { minor, currency }
    : null;
}
export function addMinor(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b))
    throw new RangeError('Unsafe minor-unit sum');
  return a + b;
}
export async function identity(...parts: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function provenance(
  provider: string,
  capturedAt: string,
  source: string,
  flags: string[] = [],
): Provenance {
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(capturedAt) ||
    !Number.isFinite(Date.parse(capturedAt))
  )
    throw new TypeError('capturedAt must be an offset-qualified instant');
  return { provider, capturedAt, source, complete: false, flags };
}
/** Posting dates are calendar dates, never browser-local instants. */
export function postingDate(input: string): string | null {
  const text = input.trim();
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const named = /^(\d{1,2})[ /-]([A-Za-z]{3})[ /-](\d{4})$/.exec(text);
  const numeric = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (iso) [, year, month, day] = iso.map(Number);
  else if (named) {
    day = Number(named[1]);
    month =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        named[2].toLowerCase(),
      ) + 1;
    year = Number(named[3]);
  } else if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = Number(numeric[3]);
  } else return null;
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}
export function singaporeDate(capturedAt: string): string {
  provenance('calendar', capturedAt, 'clock');
  return new Date(Date.parse(capturedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
/** Rolling three UTC calendar months, with day clamped to the target month's last day. */
export function threeMonthCutoff(capturedAt: string): string {
  provenance('calendar', capturedAt, 'clock');
  const now = new Date(capturedAt);
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

/** Explicit user binding is required before persisting unidentified portal captures. */
export async function bindCardCapture(
  capture: CardCapture,
  explicitAccountDiscriminator: string,
): Promise<CardCapture> {
  capture = cardCaptureSchema.parse(capture);
  if (typeof explicitAccountDiscriminator !== 'string' || !explicitAccountDiscriminator.trim())
    throw new TypeError('An explicit account discriminator is required');
  const accountId = await identity(
    capture.provenance.provider,
    capture.card,
    explicitAccountDiscriminator.trim(),
  );
  const transactions = await Promise.all(
    capture.transactions.map(async (transaction) => {
      const identityKey = transaction.identityKey ?? transaction.id;
      return {
        ...transaction,
        identityKey,
        spending: { ...transaction.spending },
        id: await identity(capture.provenance.provider, capture.card, accountId, identityKey),
      };
    }),
  );
  return {
    ...capture,
    persistence: 'account-bound',
    accountId,
    id: await identity(
      capture.provenance.provider,
      capture.card,
      accountId,
      capture.provenance.capturedAt,
    ),
    transactions,
    provenance: {
      ...capture.provenance,
      flags: [
        ...new Set(
          capture.provenance.flags
            .filter((flag) => flag !== 'ACCOUNT_CONTEXT_UNAVAILABLE' && flag !== 'EPHEMERAL_ONLY')
            .concat('EXPLICIT_USER_ACCOUNT_BINDING'),
        ),
      ],
    },
  };
}
export interface CardHistoryChange {
  transactionId: string;
  previous: CardTransaction;
  replacement: CardTransaction;
  capturedAt: string;
}
export interface CardHistory {
  accountId: string;
  card: CardCapture['card'];
  transactions: CardTransaction[];
  totalsMinor: Record<string, number>;
  coverage: 'unknown';
  ambiguousTransactionIds: string[];
  ambiguousMonths: string[];
  totalsConfidence: 'observed-only' | 'latest-capture-lower-bound';
  provenance: Provenance;
  changes: CardHistoryChange[];
  captureIds: string[];
}
/** Deduplicate overlapping snapshots by transaction ID; chronologically latest correction wins. */
export function aggregateCardHistory(
  captures: readonly CardCapture[],
  capturedAt?: string,
): CardHistory[] {
  const groups = new Map<string, { history: CardHistory; rows: Map<string, CardTransaction> }>();
  // Reconstitute daily encrypted partitions from the same observation before deciding overlap.
  const observations = new Map<string, CardCapture>();
  for (const input of captures) {
    const capture = cardCaptureSchema.parse(input);
    const key = JSON.stringify([
      capture.provenance.provider,
      capture.card,
      capture.accountId,
      capture.observationId ?? capture.id,
    ]);
    const previous = observations.get(key);
    observations.set(
      key,
      previous
        ? { ...capture, transactions: [...previous.transactions, ...capture.transactions] }
        : capture,
    );
  }
  const ordered = [...observations.values()]
    .map((capture, index) => ({ capture, index }))
    .sort(
      (a, b) =>
        Date.parse(a.capture.provenance.capturedAt) - Date.parse(b.capture.provenance.capturedAt) ||
        a.index - b.index,
    );
  for (const { capture } of ordered) {
    if (
      capture.persistence !== 'account-bound' ||
      capture.provenance.flags.includes('ACCOUNT_CONTEXT_UNAVAILABLE') ||
      capture.provenance.flags.includes('EPHEMERAL_ONLY')
    )
      throw new TypeError('Bind ephemeral captures before aggregation');
    provenance(
      capture.provenance.provider,
      capture.provenance.capturedAt,
      'loaded-capture-history',
    );
    const key = JSON.stringify([capture.provenance.provider, capture.card, capture.accountId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        history: {
          accountId: capture.accountId,
          card: capture.card,
          transactions: [],
          totalsMinor: {},
          coverage: 'unknown',
          ambiguousTransactionIds: [],
          ambiguousMonths: [],
          totalsConfidence: 'observed-only',
          provenance: provenance(
            capture.provenance.provider,
            capture.provenance.capturedAt,
            'loaded-capture-history',
            ['AGGREGATE_COVERAGE_UNKNOWN'],
          ),
          changes: [],
          captureIds: [],
        },
        rows: new Map(),
      };
      groups.set(key, group);
    }
    const { history, rows } = group;
    const ambiguous =
      capture.card === 'maybank-xl' &&
      capture.transactions.some((row) => row.identityConfidence !== 'provider-reference');
    const previousAmbiguous = history.totalsConfidence === 'latest-capture-lower-bound';
    if (ambiguous || previousAmbiguous) {
      history.ambiguousTransactionIds = [
        ...new Set([
          ...history.ambiguousTransactionIds,
          ...rows.keys(),
          ...capture.transactions
            .filter((row) => row.identityConfidence !== 'provider-reference')
            .map((row) => row.id),
        ]),
      ];
      history.ambiguousMonths = [
        ...new Set([
          ...history.ambiguousMonths,
          ...[...rows.values(), ...capture.transactions].map((row) => row.postingDate.slice(0, 7)),
        ]),
      ];
      history.totalsConfidence = 'latest-capture-lower-bound';
      history.provenance.flags = [
        ...new Set([
          ...history.provenance.flags,
          'SNAPSHOT_LOCAL_IDENTITY_AMBIGUITY',
          'LATEST_CAPTURE_ONLY',
        ]),
      ];
      rows.clear(); // Cannot infer either overlap or disjointness; do not accumulate synthetic occurrences.
    }
    history.provenance.capturedAt = capture.provenance.capturedAt;
    history.provenance.flags = [
      ...new Set([...history.provenance.flags, ...capture.provenance.flags]),
    ];
    if (!history.captureIds.includes(capture.id)) history.captureIds.push(capture.id);
    for (const transaction of capture.transactions) {
      if (
        !transaction.id ||
        postingDate(transaction.postingDate) !== transaction.postingDate ||
        !Number.isSafeInteger(transaction.spending.minor) ||
        !/^[A-Z]{3}$/.test(transaction.spending.currency)
      )
        throw new TypeError('Invalid history transaction');
      const copy = { ...transaction, spending: { ...transaction.spending } };
      const previous = rows.get(transaction.id);
      if (
        previous &&
        JSON.stringify([
          previous.reference,
          previous.postingDate,
          previous.transactionDate,
          previous.merchant,
          previous.spending.minor,
          previous.spending.currency,
        ]) !==
          JSON.stringify([
            copy.reference,
            copy.postingDate,
            copy.transactionDate,
            copy.merchant,
            copy.spending.minor,
            copy.spending.currency,
          ])
      ) {
        history.changes.push({
          transactionId: transaction.id,
          previous,
          replacement: copy,
          capturedAt: capture.provenance.capturedAt,
        });
        history.provenance.flags = [
          ...new Set([...history.provenance.flags, 'TRANSACTION_CORRECTIONS_PRESENT']),
        ];
      }
      rows.set(transaction.id, copy);
    }
  }
  return [...groups.values()].map(({ history, rows }) => {
    history.transactions = retainThreeMonths(
      [...rows.values()],
      capturedAt ?? history.provenance.capturedAt,
    ).sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.id.localeCompare(b.id));
    const totals = new Map<string, number>();
    for (const row of history.transactions)
      totals.set(
        row.spending.currency,
        addMinor(totals.get(row.spending.currency) ?? 0, row.spending.minor),
      );
    history.totalsMinor = Object.fromEntries(totals);
    return history;
  });
}

export interface PostingDatePartition {
  capture: CardCapture;
  occurredAt: string;
}
/** Encrypt/persist one document per posting day; observation time must not extend retention. */
export async function partitionCardCaptureByPostingDate(
  capture: CardCapture,
): Promise<PostingDatePartition[]> {
  capture = cardCaptureSchema.parse(capture);
  if (capture.persistence !== 'account-bound')
    throw new TypeError('Bind capture before partitioning');
  const days = new Map<string, CardTransaction[]>();
  for (const row of capture.transactions) {
    if (postingDate(row.postingDate) !== row.postingDate)
      throw new TypeError('Invalid posting date');
    const list = days.get(row.postingDate) ?? [];
    list.push(row);
    days.set(row.postingDate, list);
  }
  return Promise.all(
    [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([day, transactions]) => ({
        occurredAt: `${day}T00:00:00.000Z`,
        capture: {
          ...capture,
          observationId: capture.observationId ?? capture.id,
          id: await identity(capture.id, 'posting-date', day),
          transactions: transactions.map((row) => ({ ...row, spending: { ...row.spending } })),
          provenance: { ...capture.provenance, flags: [...capture.provenance.flags] },
        },
      })),
  );
}

export * from './schemas';
export * from './allocations';
export function retainThreeMonths<T extends { postingDate: string }>(
  rows: readonly T[],
  capturedAt: string,
): T[] {
  const cutoff = threeMonthCutoff(capturedAt),
    today = singaporeDate(capturedAt);
  return rows.filter(
    (row) =>
      postingDate(row.postingDate) === row.postingDate &&
      row.postingDate >= cutoff &&
      row.postingDate <= today,
  );
}
