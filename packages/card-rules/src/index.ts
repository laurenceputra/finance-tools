import { addMinor, retainThreeMonths, threeMonthCutoff, parseCardSettings } from '../../portfolio-domain/src/index';
import type { CardCapture, CardTransaction } from '../../portfolio-domain/src/index';
export interface CardSettings { selectedCategories: readonly string[]; defaultCategory?: string; merchantMap?: Readonly<Record<string, string>> }
export interface RuleMetadata { status: 'UNVERIFIED'; version: string; effectiveFrom: null; source: string; capMinor: number; mode: 'per-category' | 'combined' }
export const RULES: Readonly<Record<CardCapture['card'], RuleMetadata>> = {
  'uob-lady-solitaire': { status: 'UNVERIFIED', version: 'legacy-source-fixture-v1', effectiveFrom: null, source: 'bank-cc-limits-subcap-calculator.user.js fallback policy; fixture-derived, not issuer-confirmed', capMinor: 75000, mode: 'per-category' },
  'maybank-xl': { status: 'UNVERIFIED', version: 'legacy-source-fixture-v1', effectiveFrom: null, source: 'bank-cc-limits-subcap-calculator.user.js fallback policy; fixture-derived, not issuer-confirmed', capMinor: 100000, mode: 'combined' }
};
function pattern(value: string): { literal: string; wildcard: boolean; regex: RegExp } {
  let literal = '', source = '', wildcard = false;
  for (let i = 0; i < value.length; i++) {
    let char = value[i];
    if (char === '\\' && i + 1 < value.length) char = value[++i];
    else if (char === '*') { source += '[^*]*'; literal += '*'; wildcard = true; continue; }
    literal += char; source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return { literal, wildcard, regex: new RegExp(`^${source}$`, 'i') };
}
export function resolveCategory(merchant: string, settings: CardSettings, card: CardCapture['card']): string {
  const entries = Object.entries(settings.merchantMap ?? {}).filter(([key, value]) => !['__proto__', 'constructor', 'prototype'].includes(key) && value);
  const escaped = merchant.replace(/[\\*]/g, '\\$&');
  const direct = entries.find(([key]) => key === escaped) ?? entries.find(([key]) => key === merchant);
  if (direct) return direct[1];
  const exact = entries.find(([key]) => { const p = pattern(key); return (!p.wildcard || merchant.includes('*')) && p.literal.toUpperCase() === merchant.toUpperCase(); });
  if (exact) return exact[1];
  const wild = entries.find(([key]) => { const p = pattern(key); return p.wildcard && p.regex.test(merchant); });
  if (wild) return wild[1];
  if (card === 'maybank-xl' && merchant) return /\bSGP$/i.test(merchant.trim()) ? 'Local' : 'Forex';
  return settings.defaultCategory || 'Others';
}
export interface CardEvaluationContext { ambiguousMonths?: readonly string[]; coverage?: 'unknown' }
export interface MonthlyRuleResult { month: string; totals: Record<string, number>; totalMinor: number; eligibleMinor: number; remainingMinor: Record<string, number> | null; rule: RuleMetadata; incomplete: true; warnings: string[] }
export function evaluateMonthly(card: CardCapture['card'], transactions: readonly CardTransaction[], settings: CardSettings, capturedAt: string, context: CardEvaluationContext = {}): MonthlyRuleResult[] {
  if (!Object.hasOwn(RULES, card)) throw new TypeError('Unsupported card');
  const validated = parseCardSettings(settings);
  settings = validated;
  const rule = RULES[card], months = new Map<string, Map<string, number>>();
  for (const transaction of retainThreeMonths(transactions, capturedAt)) {
    if (transaction.spending.currency !== 'SGD' || !Number.isSafeInteger(transaction.spending.minor)) throw new TypeError('Rules require safe SGD minor units');
    const month = transaction.postingDate.slice(0, 7), category = resolveCategory(transaction.merchant, settings, card);
    const totals = months.get(month) ?? new Map<string, number>(); months.set(month, totals);
    totals.set(category, addMinor(totals.get(category) ?? 0, transaction.spending.minor));
  }
  return [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, totals]) => {
    const selected = [...new Set(settings.selectedCategories)];
    const totalMinor = [...totals.values()].reduce(addMinor, 0);
    const selectedTotal = selected.reduce((sum, category) => addMinor(sum, totals.get(category) ?? 0), 0);
    const eligibleMinor = rule.mode === 'combined' ? Math.min(rule.capMinor, Math.max(0, selectedTotal)) : selected.reduce((sum, category) => addMinor(sum, Math.min(rule.capMinor, Math.max(0, totals.get(category) ?? 0))), 0);
    const warnings = ['SOURCE_COVERAGE_UNKNOWN', 'RULE_UNVERIFIED'];
    const cutoff = threeMonthCutoff(capturedAt);
    const partial = month === cutoff.slice(0, 7) && cutoff.slice(8) !== '01';
    const ambiguous = context.ambiguousMonths?.includes(month) || (card === 'maybank-xl' && transactions.some(row => row.postingDate.slice(0, 7) === month && row.identityConfidence !== 'provider-reference'));
    if (partial) warnings.push('PARTIAL_RETENTION_MONTH');
    if (ambiguous) warnings.push('SNAPSHOT_LOCAL_IDENTITY_AMBIGUITY');
    const remainingMinor = partial || ambiguous ? null : rule.mode === 'combined' ? { combined: Math.max(0, rule.capMinor - Math.max(0, selectedTotal)) } : Object.fromEntries(selected.map(category => [category, Math.max(0, rule.capMinor - Math.max(0, totals.get(category) ?? 0))]));
    return { month, totals: Object.fromEntries(totals), totalMinor, eligibleMinor, remainingMinor, rule, incomplete: true as const, warnings };
  });
}
