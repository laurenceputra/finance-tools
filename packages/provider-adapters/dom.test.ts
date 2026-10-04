import { expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { aggregateCardHistory, bindCardCapture, captureMaybank, captureUob } from './src/index';
const capturedAt = '2025-03-31T16:00:00Z';
function documentFor(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}
const uobRow = (amount = '-10.00', merchant = 'SHOP', date = '01 Apr 2025', reference = '900719925474099312345') => `<tr><td><div><span>31 Mar 2025</span><span>${date}</span></div></td><td>${merchant} Ref No: ${reference}</td><td></td><td>${amount} SGD</td><td></td></tr>`;
const uobTable = (rows: string) => `<table><tbody>${rows}</tbody></table>`;
const uob = (rows: string) => `<section data-account-id="secret-111"><h2>LADY'S SOLITAIRE CARD</h2>${uobTable(rows)}</section>`;
const maybankRow = (amount = '-12.34 SGD', date = '01 Apr 2025') => `<tr><td>${date}</td><td></td><td>SHOP SGP</td><td>${amount}</td></tr>`;
it('captures owned visible SPA rows with long string references, refunds and calendar cutoff', async () => {
  const result = await captureUob(documentFor(uob(uobRow() + uobRow('2.00', 'SHOP', '01 Apr 2025', '222') + uobRow('-20.00', 'PAYMT THRU E-BANK/HOMEB/CYBERB') + uobRow('-3.00', 'OLD', '30 Dec 2024'))), capturedAt);
  expect(result[0].transactions).toHaveLength(2);
  expect(result[0].transactions[0].reference).toBe('900719925474099312345');
  expect(result[0].transactions.map(t => t.spending.minor)).toEqual([1000, -200]);
  expect(result[0].id).not.toContain('secret-111'); expect(result[0].provenance.complete).toBe(false);
});
it('rejects hidden headings, ambiguous tables and missing row fields', async () => {
  expect(await captureUob(documentFor(`<div hidden>${uob(uobRow())}</div>`), capturedAt)).toEqual([]);
  expect(await captureUob(documentFor(`<section><h2>LADY'S SOLITAIRE CARD</h2>${uobTable(uobRow())}${uobTable(uobRow())}</section>`), capturedAt)).toEqual([]);
  const invalid = uobRow().replace('Ref No: 900719925474099312345', '') + uobRow('-1.00', 'INVALID', '31 Feb 2025') + `<tr hidden>${uobRow().replace(/<\/?tr>/g, '')}</tr>`;
  expect((await captureUob(documentFor(uob(invalid)), capturedAt))[0].transactions).toEqual([]);
});
it('does not pick arbitrary tables for unsupported Maybank cards', async () => {
  expect(await captureMaybank(documentFor(`<section><h2>Other Card</h2>${uobTable(maybankRow())}</section><section><h2>XL Rewards Card</h2></section>`), capturedAt)).toEqual([]);
  expect(await captureMaybank(documentFor(`<section><h2>XL Rewards Card</h2><h2>Other Card</h2>${uobTable(maybankRow())}</section>`), capturedAt)).toEqual([]);
});
it('preserves duplicate Maybank occurrences, omits credits with a warning and uses stable ids', async () => {
  const html = `<section data-account-id="secret-222"><h2>XL Rewards Card</h2>${uobTable(maybankRow() + maybankRow() + maybankRow('4.00 SGD') + maybankRow('-3.00 SGD', '31 Feb 2025'))}</section>`;
  const first = (await captureMaybank(documentFor(html), capturedAt))[0];
  const second = (await captureMaybank(documentFor(html), capturedAt))[0];
  expect(first.transactions).toHaveLength(2);
  expect(first.transactions[0].id).not.toBe(first.transactions[1].id);
  expect(first.transactions.map(t => t.id)).toEqual(second.transactions.map(t => t.id));
  expect(first.provenance.flags).toContain('LEGACY_DEBIT_ONLY_CREDITS_OMITTED');
});
it('supports explicit user binding and stable UOB reference identities across corrected captures', async () => {
  const firstDocument = documentFor(uob(uobRow()).replace(' data-account-id="secret-111"', ''));
  const first = (await captureUob(firstDocument, capturedAt))[0];
  expect(first.persistence).toBe('ephemeral'); expect(first.provenance.flags).toContain('EPHEMERAL_ONLY');
  const corrected = (await captureUob(documentFor(uob(uobRow('-8.00', 'CORRECTED SHOP')).replace(' data-account-id="secret-111"', '')), '2025-04-02T00:00:00Z'))[0];
  const a = await bindCardCapture(first, 'user account A'), b = await bindCardCapture(corrected, 'user account A');
  expect(a.transactions[0].id).toBe(b.transactions[0].id);
  const history = aggregateCardHistory([a, b])[0];
  expect(history.totalsMinor.SGD).toBe(800); expect(history.transactions).toHaveLength(1); expect(history.changes).toHaveLength(1);
});
it('uses only observed explicit Maybank row references for cross-capture correction identity', async () => {
  const html = (amount: string) => `<section data-account-id="account"><h2>XL Rewards Card</h2>${uobTable(maybankRow(amount).replace('<tr>', '<tr data-ref-no="MB-12345678901234567890">'))}</section>`;
  const early = (await captureMaybank(documentFor(html('-12.34 SGD')), capturedAt))[0];
  const late = (await captureMaybank(documentFor(html('-10.00 SGD')), '2025-04-02T00:00:00Z'))[0];
  expect(early.transactions[0].identityConfidence).toBe('provider-reference');
  expect(early.transactions[0].reference).toBe('MB-12345678901234567890');
  expect(aggregateCardHistory([early, late])[0]).toMatchObject({ totalsMinor: { SGD: 1000 }, totalsConfidence: 'observed-only', ambiguousMonths: [] });
});
