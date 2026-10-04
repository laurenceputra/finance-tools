import { z } from 'zod';
import { postingDate } from './index';
export const providerSchema = z.enum(['endowus', 'fsm', 'ocbc', 'uob', 'maybank', 'uob-lady-solitaire', 'maybank-xl']);
export const cardSchema = z.enum(['uob-lady-solitaire', 'maybank-xl']);
export const timestampSchema = z.string().datetime({ offset: true }).refine(value => postingDate(value.slice(0, 10)) !== null && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 300000, 'Invalid or future timestamp');
const id = z.string().min(1).max(512);
const safeInteger = z.number().int().safe();
export const moneySchema = z.object({ minor: safeInteger, currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const accountTypeSchema = z.enum(['CPF', 'SRS', 'cash', 'unknown']);
export const provenanceSchema = z.object({ provider: providerSchema, capturedAt: timestampSchema, source: z.string().min(1), complete: z.literal(false), flags: z.array(z.string()) }).strict();
const date = z.string().refine(value => postingDate(value) === value, 'Invalid posting date');
export const holdingSchema = z.object({ id, name: z.string(), section: z.enum(['asset', 'liability']), code: z.string(), subcode: z.string(), valuation: moneySchema.nullable(), profit: moneySchema.nullable(), costBasis: moneySchema.nullable(), returnPercent: z.number().finite().nullable(), flags: z.array(z.string()), goalId: id.optional() }).strict();
export const portfolioSnapshotSchema = z.object({ id, accountId: id, accountType: accountTypeSchema.optional(), provenance: provenanceSchema, holdings: z.array(holdingSchema) }).strict().refine(value => ['endowus', 'fsm', 'ocbc'].includes(value.provenance.provider), 'Portfolio/provider mismatch');
export const cardTransactionSchema = z.object({ id, identityKey: id.optional(), identityConfidence: z.enum(['provider-reference', 'snapshot-local']).optional(), reference: z.string(), postingDate: date, transactionDate: date.nullable(), merchant: z.string().min(1), spending: moneySchema }).strict();
export const cardCaptureSchema = z.object({ id, observationId: id.optional(), accountId: id, persistence: z.enum(['ephemeral', 'account-bound']), card: cardSchema, provenance: provenanceSchema, transactions: z.array(cardTransactionSchema) }).strict().superRefine((value, context) => {
  const expected = value.card === 'uob-lady-solitaire' ? ['uob', 'uob-lady-solitaire'] : ['maybank', 'maybank-xl'];
  if (!expected.includes(value.provenance.provider)) context.addIssue({ code: 'custom', message: 'Card/provider mismatch' });
  if (value.persistence === 'account-bound' && value.provenance.flags.some(flag => ['EPHEMERAL_ONLY', 'ACCOUNT_CONTEXT_UNAVAILABLE'].includes(flag))) context.addIssue({ code: 'custom', message: 'Bound capture has ephemeral flags' });
});
/** Reject dangerous own keys; inherited keys never become merchant rules. Legitimate toString is allowed. */
export const safeRecordSchema = <T extends z.ZodTypeAny>(value: T) => z.custom<Record<string, z.infer<T>>>(input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const proto = Object.getPrototypeOf(input);
  return (proto === Object.prototype || proto === null) && Object.keys(input).every(key => !['__proto__', 'prototype', 'constructor'].includes(key));
}, 'Expected safe own-property record').pipe(z.record(value));
export const cardSettingsSchema = z.object({ selectedCategories: z.array(z.string().min(1)).max(2), defaultCategory: z.string().min(1).optional(), merchantMap: safeRecordSchema(z.string().min(1)).optional() }).strict();
export const allocationTargetSchema = z.union([
  z.object({ targetBps: z.number().int().min(0).max(10000), fixed: z.boolean().optional(), excluded: z.boolean().optional() }).strict(),
  z.object({ targetAmount: moneySchema.refine(value => value.minor >= 0), fixed: z.boolean().optional(), excluded: z.boolean().optional() }).strict(),
  z.object({ fixed: z.boolean(), excluded: z.boolean().optional() }).strict(),
  z.object({ excluded: z.literal(true), fixed: z.boolean().optional() }).strict()
]);
export const allocationScopeSchema = z.object({ id, bucket: z.string().min(1), accountId: id, goalId: id.optional(), holdingIds: z.array(id).optional(), currency: z.string().regex(/^[A-Z]{3}$/), section: z.enum(['asset', 'liability']), accountType: accountTypeSchema, targets: safeRecordSchema(allocationTargetSchema), projectedDeposit: moneySchema.refine(value => value.minor >= 0).optional() }).strict().superRefine((scope, context) => {
  if (scope.holdingIds && new Set(scope.holdingIds).size !== scope.holdingIds.length) context.addIssue({ code: 'custom', message: 'Duplicate bucket holding IDs' });
  if (scope.holdingIds && Object.keys(scope.targets).some(key => !scope.holdingIds!.includes(key))) context.addIssue({ code: 'custom', message: 'Target is outside bucket holding membership' });
  if (scope.projectedDeposit && (scope.projectedDeposit.currency !== scope.currency || scope.section === 'liability')) context.addIssue({ code: 'custom', message: 'Deposit requires same-currency asset scope' });
  let bps = 0;
  for (const target of Object.values(scope.targets)) {
    if ('targetAmount' in target && target.targetAmount.currency !== scope.currency) context.addIssue({ code: 'custom', message: 'Target currency mismatch' });
    if ('targetBps' in target && !target.excluded && !target.fixed) bps += target.targetBps;
  }
  if (bps > 10000) context.addIssue({ code: 'custom', message: 'Targets exceed 10000 basis points' });
});
export const allocationSettingsSchema = z.object({ scopes: z.array(allocationScopeSchema) }).strict().refine(value => new Set(value.scopes.map(scope => scope.id)).size === value.scopes.length, 'Duplicate scope IDs');
export const productSettingsSchema = z.object({ allocations: allocationSettingsSchema, cards: safeRecordSchema(cardSettingsSchema) }).strict();
export const normalizedProductPayloadSchema = z.object({ snapshots: z.array(portfolioSnapshotSchema), captures: z.array(cardCaptureSchema), settings: productSettingsSchema }).strict();
export type AllocationTarget = z.infer<typeof allocationTargetSchema>;
export type AllocationScope = z.infer<typeof allocationScopeSchema>;
export type AllocationSettings = z.infer<typeof allocationSettingsSchema>;
export type ProductSettings = z.infer<typeof productSettingsSchema>;
export type NormalizedProductPayload = z.infer<typeof normalizedProductPayloadSchema>;
export const parsePortfolioSnapshot = (input: unknown) => portfolioSnapshotSchema.parse(input);
export const parseCardCapture = (input: unknown) => cardCaptureSchema.parse(input);
export const parseAllocationSettings = (input: unknown) => allocationSettingsSchema.parse(input);
export const parseCardSettings = (input: unknown) => cardSettingsSchema.parse(input);
export const parseProductSettings = (input: unknown) => productSettingsSchema.parse(input);
export const parseNormalizedProductPayload = (input: unknown) => normalizedProductPayloadSchema.parse(input);
