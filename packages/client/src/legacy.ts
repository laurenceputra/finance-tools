import type { Product } from '@finance-tools/contracts';
import { parseCardSettings } from '@finance-tools/portfolio-domain';
import { validateJson, validateSettings } from './data';
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected legacy configuration object'); return value as Record<string, unknown>; };
/** Deliberate local file migration. Never contacts old endpoints, matches emails or imports credentials. */
export function previewLegacyConfig(input: unknown, origin: Product, accountMap: Record<string, string> = {}) {
  validateJson(input); if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 2 * 1024 * 1024) throw new Error('Legacy config limit is 2 MiB');
  const file = record(input), warnings = ['LOCAL_CONFIG_ONLY', 'REVIEW_BEFORE_APPLYING', 'NO_EMAIL_ACCOUNT_MATCHING'];
  if (origin === 'portfolio') {
    const platforms = record(file.platforms), review: Record<string, unknown> = {};
    for (const provider of ['endowus', 'fsm', 'ocbc']) {
      if (!Object.hasOwn(platforms, provider)) continue;
      const allocation = record(record(platforms[provider]).allocation);
      const allowed = provider === 'endowus' ? ['goalTargets', 'goalFixed', 'goalBuckets', 'clearedGoalBuckets', 'allocationModel'] : provider === 'fsm' ? ['targetsByCode', 'fixedByCode', 'portfolios', 'assignmentByCode', 'allocationModel'] : ['allocationBuckets', 'subPortfolios', 'assignmentByCode', 'orderByScope', 'targetsByScope', 'allocationModel'];
      review[provider] = Object.fromEntries(allowed.filter(key => Object.hasOwn(allocation, key)).map(key => [key, allocation[key]]));
    }
    if (!Object.keys(review).length) throw new Error('Not a recognized portfolio config export');
    warnings.push('LEGACY_CODES_REQUIRE_EXPLICIT_CURRENT_ACCOUNT_HOLDING_SCOPE_MAPPING');
    return { settings: validateSettings({ allocations: { scopes: [] }, cards: {}, legacyAllocationReview: review }), warnings };
  }
  const data = file.data === undefined ? file : record(file.data), cards = record(data.cards), templates: Record<string, unknown> = {}, mapped: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(cards)) {
    const old = record(input), parsed = parseCardSettings({ selectedCategories: old.selectedCategories ?? [], ...(old.defaultCategory !== undefined ? { defaultCategory: old.defaultCategory } : {}), ...(old.merchantMap !== undefined ? { merchantMap: old.merchantMap } : {}) });
    templates[name] = parsed;
    if (Object.hasOwn(accountMap, name)) { if (!accountMap[name]) throw new Error('Explicit current account ID required'); mapped[accountMap[name]] = parsed; }
  }
  if (!Object.keys(templates).length) throw new Error('No recognized legacy card configurations');
  if (!Object.keys(mapped).length) warnings.push('CARD_TEMPLATES_NOT_APPLIED_UNTIL_EXPLICIT_BOUND_ACCOUNT_MAPPING');
  return { settings: validateSettings({ allocations: { scopes: [] }, cards: mapped, legacyCardTemplates: templates }), warnings };
}
