import { addMinor, identity, money, minorUnits, postingDate, provenance, retainThreeMonths } from '../../portfolio-domain/src/index';
import type { CardCapture, CardTransaction, Holding, Money, PortfolioSnapshot } from '../../portfolio-domain/src/index';
export type { CardCapture, CardTransaction, Holding, Money, PortfolioSnapshot } from '../../portfolio-domain/src/index';
export { bindCardCapture, aggregateCardHistory, partitionCardCaptureByPostingDate } from '../../portfolio-domain/src/index';
export type { CardHistory, CardHistoryChange } from '../../portfolio-domain/src/index';
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
function currency(value: unknown, fallback = ''): string { const r = object(value); return text(r.currency) || text(r.currencyCode) || fallback; }
async function snapshot(provider: string, account: string, capturedAt: string, holdings: Holding[], flags: string[] = []): Promise<PortfolioSnapshot> {
  const accountId = await identity(provider, account);
  return { id: await identity(provider, accountId, capturedAt), accountId, accountType: 'unknown', holdings, provenance: provenance(provider, capturedAt, 'loaded-api-response', [...flags, 'ACCOUNT_TYPE_UNKNOWN']) };
}
function holding(id: string, name: string, code: string, subcode: string, valuation: Money | null, profit: Money | null, returnPercent: number | null, flags: string[] = [], section: Holding['section'] = 'asset'): Holding {
  const costBasis = valuation && profit && valuation.currency === profit.currency ? { currency: valuation.currency, minor: addMinor(valuation.minor, -profit.minor) } : null;
  return { id, name, code, subcode, valuation, profit, costBasis, returnPercent, flags, section };
}
export interface EndowusInput { performance: unknown; investible: unknown; goals: unknown }
export async function normalizeEndowus(input: EndowusInput, capturedAt: string): Promise<PortfolioSnapshot[]> {
  const arrays = [rows(input.performance), rows(input.investible), rows(input.goals)];
  const ids = new Set(arrays.flatMap(list => list.map(row => text(row.goalId)).filter(Boolean)));
  const result: PortfolioSnapshot[] = [];
  for (const goalId of ids) {
    const [p, i, g] = arrays.map(list => list.find(row => row.goalId === goalId) ?? {});
    const amount = minorUnits(p.totalInvestmentValue) !== null ? p.totalInvestmentValue : i.totalInvestmentAmount;
    const ccy = currency(amount, text(p.currency) || text(i.currency) || text(g.currency) || 'SGD');
    let valuation = money(amount, ccy);
    const pending = money(p.pendingProcessingAmount, currency(p.pendingProcessingAmount, ccy));
    const flags = ['ENDOWUS_TOTAL_INVESTMENT_AMOUNT_IS_VALUATION', 'SINGAPORE_SOURCE_LOCAL_CURRENCY'];
    if (valuation && pending && valuation.currency === pending.currency) valuation = { ...valuation, minor: addMinor(valuation.minor, pending.minor) };
    else if (p.pendingProcessingAmount !== undefined && p.pendingProcessingAmount !== null) flags.push('PENDING_AMOUNT_UNRESOLVED');
    const profit = money(p.totalCumulativeReturn, currency(p.totalCumulativeReturn, ccy));
    result.push(await snapshot('endowus', goalId, capturedAt, [holding(await identity('endowus', goalId), text(i.goalName) || text(g.goalName), goalId, '', valuation, profit, percent(p.simpleRateOfReturnPercent), flags)]));
  }
  return result;
}
export async function normalizeFsm(payload: unknown, capturedAt: string): Promise<PortfolioSnapshot[]> {
  const result: PortfolioSnapshot[] = [];
  for (const account of rows(object(payload).data)) {
    const refno = text(account.refno);
    if (!refno) continue;
    const holdings: Holding[] = [];
    for (const row of rows(account.holdings)) {
      if (row.productType === 'DPMS_HEADER' || !text(row.code)) continue;
      const ccy = text(row.currencyLcy) || text(account.currencyLcy) || 'SGD';
      holdings.push(holding(await identity('fsm', refno, row.code, row.subcode ?? ''), text(row.name), text(row.code), text(row.subcode), money(row.currentValueLcy, ccy), money(row.profitValueLcy, ccy), percent(row.profitPercentLcy), ['SINGAPORE_SOURCE_LOCAL_CURRENCY']));
    }
    result.push(await snapshot('fsm', refno, capturedAt, holdings));
  }
  return result;
}
export async function normalizeOcbc(payload: unknown, capturedAt: string): Promise<PortfolioSnapshot[]> {
  const grouped = new Map<string, Holding[]>();
  for (const group of rows(object(payload).data)) {
    const account = text(group.portfolioNo);
    if (!account) continue;
    const holdings = grouped.get(account) ?? []; grouped.set(account, holdings);
    for (const section of ['assets', 'liabilities'] as const) for (const asset of rows(group[section])) for (const sub of rows(asset.subAssets)) for (const row of rows(sub.holdings)) {
      const flags: string[] = [];
      const referenceCurrency = text(row.referenceCcy) || text(group.referenceCcy);
      let valuation = money(row.marketValueReferenceCcy, referenceCurrency);
      let ccy = referenceCurrency;
      if (!valuation) {
        ccy = text(row.originalCcy);
        valuation = money(row.marketValueOriginalCcy, ccy);
        if (!valuation) {
          ccy = text(row.marketValueCcy) || text(row.currency);
          valuation = money(row.marketValue, ccy);
          if (minorUnits(row.marketValue) !== null && !ccy) flags.push('AMBIGUOUS_GENERIC_MARKET_VALUE_CURRENCY');
        }
        flags.push('VALUATION_FALLBACK');
      }
      if (!valuation) flags.push('UNKNOWN_OR_AMBIGUOUS_CURRENCY_OR_VALUE');
      const key = text(row.positionId) || text(row.isin) || text(row.fundCode) || text(row.description);
      if (!key) flags.push('INDEX_IDENTITY_FALLBACK');
      const id = await identity('ocbc', account, section, asset.assetClassDesc, sub.subAssetClassDesc, key || holdings.length, row.subcode ?? row.subCode ?? '');
      const profit = money(row.totalUnrealisedPLRefCcy, referenceCurrency) ?? money(row.totalPl, text(row.totalPlCcy) || text(row.currency));
      holdings.push(holding(id, text(row.fundName) || text(row.companyName) || text(row.description), key, text(row.subcode ?? row.subCode), valuation, profit, percent(object(row.unrealisedPLPercent).parsedValue ?? row.unrealisedPLPercent), flags, section === 'assets' ? 'asset' : 'liability'));
    }
  }
  return Promise.all([...grouped].map(([account, holdings]) => snapshot('ocbc', account, capturedAt, holdings)));
}

function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return true;
}
function visibleText(element: Element): string {
  if (!visible(element)) return '';
  return Array.from(element.childNodes).map(node => node.nodeType === 3 ? node.textContent ?? '' : node.nodeType === 1 ? visibleText(node as Element) : '').join(' ').replace(/\s+/g, ' ').trim();
}
/** A heading owns the smallest ancestor containing exactly that visible supported heading and a qualified table. */
function ownedTable(document: Document, card: CardCapture['card']): { heading: Element; table: Element; scope: Element } | null {
  const headings = Array.from(document.querySelectorAll(card === 'uob-lady-solitaire' ? 'h2' : 'h1,h2,h3,h4,h5,h6'));
  const matches = headings.filter(h => visible(h) && (card === 'uob-lady-solitaire' ? visibleText(h) === "LADY'S SOLITAIRE CARD" : /\bXL\s+REWARDS\b/i.test(visibleText(h))));
  if (matches.length !== 1) return null;
  const heading = matches[0];
  for (let scope = heading.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
    if (Array.from(scope.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible).length !== 1) continue;
    const tables = Array.from(scope.querySelectorAll('table')).filter(table => visible(table) && Array.from(table.querySelectorAll('tbody tr')).some(row => {
      const cells = row.querySelectorAll('td');
      return visible(row) && (card === 'uob-lady-solitaire' ? cells.length === 5 && cells[0].querySelectorAll('div span').length === 2 : cells.length >= 3 && postingDate(visibleText(cells[0])) !== null && Array.from(cells).some(cell => /SGD/.test(visibleText(cell))));
    }));
    if (tables.length === 1) return { heading, table: tables[0], scope };
    if (tables.length > 1) return null;
  }
  return null;
}
async function capture(document: Document, capturedAt: string, card: CardCapture['card']): Promise<CardCapture[]> {
  provenance(card, capturedAt, 'visible-owned-table');
  const owned = ownedTable(document, card);
  if (!owned) return [];
  // Only explicit account context is accepted; do not merge unidentified same-product cards.
  const account = owned.scope.getAttribute('data-account-id') || owned.scope.getAttribute('data-card-id');
  const flags = account ? [] : ['ACCOUNT_CONTEXT_UNAVAILABLE', 'EPHEMERAL_ONLY'];
  if (card === 'maybank-xl') flags.push('LEGACY_DEBIT_ONLY_CREDITS_OMITTED');
  else flags.push('FIXTURE_INFERRED_SIGN_INVERSION');
  const accountId = await identity(card, account || 'unidentified-visible-card');
  const transactions: CardTransaction[] = [], counts = new Map<string, number>();
  for (const row of Array.from(owned.table.querySelectorAll('tbody tr'))) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (!visible(row) || cells.some(cell => !visible(cell))) continue;
    let date: string | null, transactionDate: string | null = null, merchant: string, reference: string, raw: number | null;
    let identityConfidence: 'provider-reference' | 'snapshot-local' = card === 'uob-lady-solitaire' ? 'provider-reference' : 'snapshot-local';
    if (card === 'uob-lady-solitaire') {
      if (cells.length !== 5) continue;
      const dates = Array.from(cells[0].querySelectorAll('div span')).filter(visible);
      if (dates.length !== 2 || visibleText(cells[2])) continue;
      date = postingDate(visibleText(dates[1])); transactionDate = postingDate(visibleText(dates[0]));
      const description = visibleText(cells[1]);
      if (/\bPAYMT\s+THRU\s+E-BANK\/HOMEB\/CYBERB\b/i.test(description)) continue;
      const match = /\bRef\s+No\s*:\s*(\d+)\s*$/i.exec(description);
      if (!match) { flags.push('ROW_MISSING_REFERENCE'); continue; }
      reference = match[1]; merchant = description.slice(0, match.index).trim();
      const amount = visibleText(cells[3]);
      raw = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}\s+SGD$/.test(amount) ? minorUnits(amount.replace(/\s+SGD$/, '')) : null;
    } else {
      if (cells.length < 3) continue;
      date = postingDate(visibleText(cells[0])); merchant = visibleText(cells[2]);
      const amount = cells.map(visibleText).find(value => /SGD/.test(value)) || '';
      if (!/^\s*-/.test(amount)) continue;
      raw = minorUnits(amount.replace(/\s*SGD\s*/, '').trim());
      const observedReference = row.getAttribute('data-ref-no') || row.getAttribute('data-reference');
      if (observedReference && /^[A-Za-z0-9-]{1,128}$/.test(observedReference)) {
        reference = observedReference;
        identityConfidence = 'provider-reference';
      } else reference = await identity(card, accountId, date, merchant, raw);
    }
    if (!date || !merchant || raw === null) { flags.push('INVALID_ROW'); continue; }
    const base = identityConfidence === 'provider-reference' ? await identity(card, reference) : await identity(card, date, merchant, raw);
    const occurrence = (counts.get(base) ?? 0) + 1; counts.set(base, occurrence);
    const identityKey = await identity(base, occurrence);
    transactions.push({ id: await identity(card, accountId, identityKey), identityKey, identityConfidence, reference, postingDate: date, transactionDate, merchant, spending: { minor: -raw, currency: 'SGD' } });
  }
  return [{ id: await identity(card, accountId, capturedAt), accountId, persistence: account ? 'account-bound' : 'ephemeral', card, transactions: retainThreeMonths(transactions, capturedAt), provenance: provenance(card, capturedAt, 'visible-owned-table', [...new Set(flags)]) }];
}
export function captureUob(document: Document, capturedAt: string): Promise<CardCapture[]> { return capture(document, capturedAt, 'uob-lady-solitaire'); }
export function captureMaybank(document: Document, capturedAt: string): Promise<CardCapture[]> { return capture(document, capturedAt, 'maybank-xl'); }
