import { expect, it } from 'vitest';
import {
  clientSchema,
  documentPutRequestSchema,
  encryptedEnvelopeSchema,
  DEFAULT_ENTITLEMENTS,
  MAX_REQUEST_BODY_BYTES,
  MAX_DOCUMENT_BYTES,
  vaultMetadataSchema,
  keyFileSchema,
  legacyRecoveryFileSchema,
  REFRESH_IDLE_DAYS,
  REFRESH_ABSOLUTE_DAYS,
} from './index';

it('strictly discriminates public vault metadata and bound key files, never exposing server wraps', () => {
  const standard = { version: 2, mode: 'standard', keyVersion: 1 };
  expect(vaultMetadataSchema.parse(standard)).toEqual(standard);
  for (const secret of ['rawKey', 'serverWrap', 'server_vault_wrap'])
    expect(vaultMetadataSchema.safeParse({ ...standard, [secret]: 'secret' }).success).toBe(false);
  expect(vaultMetadataSchema.safeParse({ ...standard, mode: 'private' }).success).toBe(false);
  const file = {
    format: 'finance-tools-key',
    version: 2,
    accountId: 'account',
    keyVersion: 1,
    recoverySecret: 'A'.repeat(43),
  };
  expect(keyFileSchema.parse(file)).toEqual(file);
  expect(keyFileSchema.safeParse({ ...file, keyVersion: 0 }).success).toBe(false);
  expect(keyFileSchema.safeParse({ ...file, unexpected: 'field' }).success).toBe(false);
  expect(
    legacyRecoveryFileSchema.parse({
      version: 1,
      accountId: 'account',
      recoverySecret: 'A'.repeat(43),
    }).version,
  ).toBe(1);
  expect([REFRESH_IDLE_DAYS, REFRESH_ABSOLUTE_DAYS]).toEqual([30, 90]);
});

it('requires explicit product scopes independently of display labels', () => {
  const client = { kind: 'userscript', name: 'Portfolio', namespaces: ['settings', 'history'] };
  expect(clientSchema.safeParse(client).success).toBe(false);
  expect(clientSchema.safeParse({ ...client, products: ['portfolio'] }).success).toBe(true);
  expect(clientSchema.safeParse({ ...client, products: ['admin'] }).success).toBe(false);
});
it('bounds key versions and requires product metadata on writes', () => {
  const envelope = {
    algorithm: 'AES-GCM',
    iv: 'A'.repeat(16),
    ciphertext: 'A'.repeat(22),
    schemaVersion: 1,
    keyVersion: 1,
  };
  const request = {
    expectedRevision: 0,
    mutationId: 'a3f8dbba-8774-4d29-8a49-4cbf3dc52410',
    envelope,
  };
  expect(documentPutRequestSchema.safeParse(request).success).toBe(false);
  expect(documentPutRequestSchema.safeParse({ ...request, product: 'bank-subcaps' }).success).toBe(
    true,
  );
  for (const keyVersion of [0, -1, 1.5, 2147483648])
    expect(encryptedEnvelopeSchema.safeParse({ ...envelope, keyVersion }).success).toBe(false);
  expect(DEFAULT_ENTITLEMENTS.maxStoredBytes).toBe(64 * 1024 * 1024);
  expect(Number.isFinite(DEFAULT_ENTITLEMENTS.maxReceipts)).toBe(true);
});
it('allows base64 expansion inside the bounded request budget', () => {
  const maxEncodedBytes = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3);
  expect(MAX_REQUEST_BODY_BYTES).toBe(1572864);
  expect(maxEncodedBytes).toBe(1398102);
  expect(maxEncodedBytes + 4096).toBeLessThan(MAX_REQUEST_BODY_BYTES);
  const envelope = {
    algorithm: 'AES-GCM',
    iv: 'A'.repeat(16),
    ciphertext: 'A'.repeat(maxEncodedBytes + 1),
    schemaVersion: 1,
    keyVersion: 1,
  };
  expect(encryptedEnvelopeSchema.safeParse(envelope).success).toBe(false);
});
