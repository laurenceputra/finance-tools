import type { Namespace, Product } from '@finance-tools/contracts';
import {
  parseProductSettings,
  parsePortfolioSnapshot,
  parseCardCapture,
  timestampSchema,
  moneySchema,
  providerSchema,
  cardSchema,
} from '@finance-tools/portfolio-domain';

export function validateJson(input: unknown, depth = 0): void {
  if (depth > 32) throw new Error('JSON nesting exceeds 32 levels');
  if (input === null || typeof input === 'boolean') return;
  if (typeof input === 'string') {
    if (input.length > 1048576) throw new Error('JSON string too large');
    return;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Nonfinite JSON number');
    return;
  }
  if (!input || typeof input !== 'object') throw new Error('Expected JSON data');
  if (Array.isArray(input)) {
    if (input.length > 10000) throw new Error('JSON array too large');
    for (const value of input) validateJson(value, depth + 1);
    return;
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null)
    throw new Error('Expected own-property JSON object');
  if (Object.keys(input).length > 10000) throw new Error('Too many JSON fields');
  for (const [key, value] of Object.entries(input)) {
    if (key.length > 512 || ['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error('Unsafe JSON key');
    validateJson(value, depth + 1);
  }
}
export function validateSettings(input: unknown): Record<string, unknown> {
  validateJson(input);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Settings must be an object');
  const value = input as Record<string, unknown>;
  parseProductSettings({
    allocations: Object.hasOwn(value, 'allocations') ? value.allocations : { scopes: [] },
    cards: Object.hasOwn(value, 'cards') ? value.cards : {},
  });
  if (value.assignments !== undefined) {
    if (
      !value.assignments ||
      typeof value.assignments !== 'object' ||
      Array.isArray(value.assignments) ||
      !Object.values(value.assignments).every((x) => typeof x === 'string')
    )
      throw new Error('Invalid category assignments');
  }
  if (value.subcaps !== undefined) {
    if (!value.subcaps || typeof value.subcaps !== 'object' || Array.isArray(value.subcaps))
      throw new Error('Invalid planning caps');
    for (const cap of Object.values(value.subcaps)) {
      const parsed = moneySchema.parse(cap);
      if (parsed.minor < 0) throw new Error('Negative planning cap');
    }
  }
  if (value.bankBindings !== undefined) {
    if (
      !value.bankBindings ||
      typeof value.bankBindings !== 'object' ||
      Array.isArray(value.bankBindings)
    )
      throw new Error('Invalid bank bindings');
    for (const entry of Object.values(value.bankBindings)) {
      if (!entry || typeof entry !== 'object') throw new Error('Invalid bank binding');
      const binding = entry as { provider: unknown; card: unknown; maskedAccount: unknown };
      providerSchema.parse(binding.provider);
      cardSchema.parse(binding.card);
      if (
        typeof binding.maskedAccount !== 'string' ||
        binding.maskedAccount.length > 80 ||
        !binding.maskedAccount.includes('*')
      )
        throw new Error('Masked account binding required');
    }
  }
  return value;
}
export function validateProductDocument(
  product: Product,
  namespace: Namespace,
  input: unknown,
  occurredAt?: string,
): unknown {
  validateJson(input);
  if (namespace === 'settings') {
    if (occurredAt !== undefined) throw new Error('Settings have no occurredAt');
    return validateSettings(input);
  }
  const timestamp = timestampSchema.parse(occurredAt);
  if (product === 'portfolio') {
    const snapshot = parsePortfolioSnapshot(input);
    if (Date.parse(timestamp) !== Date.parse(snapshot.provenance.capturedAt))
      throw new Error('Portfolio occurredAt must equal capture time');
    return snapshot;
  }
  const capture = parseCardCapture(input);
  if (capture.persistence !== 'account-bound' || !capture.transactions.length)
    throw new Error('Persisted bank history requires bound, nonempty daily captures');
  const day = timestamp.slice(0, 10);
  if (
    timestamp !== `${day}T00:00:00.000Z` ||
    capture.transactions.some((row) => row.postingDate !== day)
  )
    throw new Error('Bank occurredAt must be posting-day midnight, never observation time');
  return capture;
}
