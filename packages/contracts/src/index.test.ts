import { expect, it } from 'vitest';
import { clientSchema, documentPutRequestSchema, encryptedEnvelopeSchema, DEFAULT_ENTITLEMENTS, MAX_REQUEST_BODY_BYTES, MAX_DOCUMENT_BYTES } from './index';

it('requires explicit product scopes independently of display labels', () => {
  const client = { kind: 'userscript', name: 'Portfolio', namespaces: ['settings', 'history'] };
  expect(clientSchema.safeParse(client).success).toBe(false);
  expect(clientSchema.safeParse({ ...client, products: ['portfolio'] }).success).toBe(true);
  expect(clientSchema.safeParse({ ...client, products: ['admin'] }).success).toBe(false);
});
it('bounds key versions and requires product metadata on writes', () => {
  const envelope = { algorithm: 'AES-GCM', iv: 'A'.repeat(16), ciphertext: 'A'.repeat(22), schemaVersion: 1, keyVersion: 1 };
  const request = { expectedRevision: 0, mutationId: 'a3f8dbba-8774-4d29-8a49-4cbf3dc52410', envelope };
  expect(documentPutRequestSchema.safeParse(request).success).toBe(false);
  expect(documentPutRequestSchema.safeParse({ ...request, product: 'bank-subcaps' }).success).toBe(true);
  for (const keyVersion of [0, -1, 1.5, 2147483648]) expect(encryptedEnvelopeSchema.safeParse({ ...envelope, keyVersion }).success).toBe(false);
  expect(DEFAULT_ENTITLEMENTS.maxStoredBytes).toBe(64 * 1024 * 1024);
  expect(Number.isFinite(DEFAULT_ENTITLEMENTS.maxReceipts)).toBe(true);
});
it('allows base64 expansion inside the bounded request budget', () => {
  const maxEncodedBytes = Math.ceil(MAX_DOCUMENT_BYTES * 4 / 3);
  expect(MAX_REQUEST_BODY_BYTES).toBe(1572864);
  expect(maxEncodedBytes).toBe(1398102);
  expect(maxEncodedBytes + 4096).toBeLessThan(MAX_REQUEST_BODY_BYTES);
  const envelope = { algorithm: 'AES-GCM', iv: 'A'.repeat(16), ciphertext: 'A'.repeat(maxEncodedBytes + 1), schemaVersion: 1, keyVersion: 1 };
  expect(encryptedEnvelopeSchema.safeParse(envelope).success).toBe(false);
});
