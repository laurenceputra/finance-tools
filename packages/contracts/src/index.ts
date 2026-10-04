import { z } from 'zod';

export const API_PREFIX = '/api/v1';
export const MAX_REQUEST_BODY_BYTES = 1572864;
export const MAX_DOCUMENT_BYTES = 1048576;
export const ACCESS_TTL_SECONDS = 900;
export const REFRESH_IDLE_DAYS = 90;
export const REFRESH_ABSOLUTE_DAYS = 365;
export const HISTORY_MONTHS = 3;
export const DEFAULT_ENTITLEMENTS = {
  tier: 'free',
  namespaces: ['settings', 'history'],
  products: ['portfolio', 'bank-subcaps'],
  maxDocuments: 10000,
  maxDocumentBytes: 1048576,
  maxStoredBytes: 67108864,
  maxReceipts: 50000,
  maxMetadataBytes: 16777216,
} as const;
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const namespaceSchema = z.enum(['settings', 'history']);
export type Namespace = z.infer<typeof namespaceSchema>;
export const productSchema = z.enum(['portfolio', 'bank-subcaps']);
export type Product = z.infer<typeof productSchema>;
export const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const encoded = (bytes: number) => base64urlSchema.length(Math.ceil((bytes * 4) / 3));
export const kdfSchema = z
  .object({
    name: z.literal('PBKDF2'),
    hash: z.literal('SHA-256'),
    iterations: z.number().int().min(600000).max(2000000),
    salt: encoded(16),
  })
  .strict();
export const encryptedEnvelopeSchema = z
  .object({
    algorithm: z.literal('AES-GCM'),
    iv: encoded(12),
    ciphertext: base64urlSchema.min(22).max(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3)),
    schemaVersion: z.literal(1),
    keyVersion: z.number().int().positive().max(2147483647),
  })
  .strict();
export const vaultSchema = z
  .object({
    version: z.literal(1),
    keyVersion: z.number().int().positive().max(2147483647),
    kdf: kdfSchema,
    passphraseEnvelope: encryptedEnvelopeSchema,
    recoveryEnvelope: encryptedEnvelopeSchema,
  })
  .strict();
export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;
export type Vault = z.infer<typeof vaultSchema>;
export interface DocumentContext {
  accountId: string;
  namespace: string;
  documentId: string;
  schemaVersion: 1;
  keyVersion: number;
}
export const clientSchema = z
  .object({
    kind: z.enum(['browser', 'userscript']),
    name: z.string().min(1).max(100),
    namespaces: z.array(namespaceSchema).min(1).max(2),
    products: z.array(productSchema).min(1).max(2),
  })
  .strict();
export const exchangeRequestSchema = z
  .object({ clerkToken: z.string().min(1).max(16384), client: clientSchema })
  .strict();
export const refreshRequestSchema = z
  .object({ refreshToken: z.string().min(32).max(256).optional() })
  .strict();
export const pairingCreateRequestSchema = z.object({ client: clientSchema }).strict();
export const pairingApproveRequestSchema = z
  .object({ pairingId: idSchema, code: z.string().regex(/^[0-9]{8}$/) })
  .strict();
export const pairingInspectRequestSchema = pairingApproveRequestSchema;
export const pairingRedeemRequestSchema = z
  .object({ pairingId: idSchema, secret: z.string().min(32).max(256) })
  .strict();
export const vaultPutRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mutationId: z.string().uuid(),
    vault: vaultSchema,
  })
  .strict();
export const documentPutRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mutationId: z.string().uuid(),
    product: productSchema,
    envelope: encryptedEnvelopeSchema,
    occurredAt: z.string().datetime().optional(),
  })
  .strict();
export const documentDeleteRequestSchema = z
  .object({ expectedRevision: z.number().int().positive(), mutationId: z.string().uuid() })
  .strict();
export const accountDeleteRequestSchema = z
  .object({ clerkToken: z.string().min(1).max(16384), confirmation: z.literal('DELETE') })
  .strict();
export interface SessionTokens {
  accessToken: string;
  expiresIn: 900;
  sessionId: string;
  refreshToken?: string;
}
export interface SessionInfo {
  id: string;
  client: z.infer<typeof clientSchema>;
  createdAt: string;
  lastUsedAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}
export interface StoredDocument {
  id: string;
  namespace: Namespace;
  product: Product;
  revision: number;
  envelope: EncryptedEnvelope;
  occurredAt?: string;
  updatedAt: string;
}
export interface VaultResponse {
  revision: number;
  vault: Vault;
}
export interface ApiError {
  error: { code: string; message: string; requestId: string; currentRevision?: number };
}
export interface MeResponse {
  accountId: string;
  entitlements: typeof DEFAULT_ENTITLEMENTS;
  namespaces: Namespace[];
  products: Product[];
}
export interface PairingInspectResponse {
  client: z.infer<typeof clientSchema>;
}
export interface PairingResponse {
  pairingId: string;
  code: string;
  secret: string;
  expiresAt: string;
}
export interface DocumentListResponse {
  documents: StoredDocument[];
  cursor: string | null;
}
export interface ExportResponse {
  version: 1;
  accountId: string;
  exportedAt: string;
  vault: VaultResponse | null;
  documents: StoredDocument[];
}
export interface ConfigResponse {
  clerkPublishableKey: string;
  apiVersion: 1;
  historyMonths: 3;
}
