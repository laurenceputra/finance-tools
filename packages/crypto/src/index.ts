import { encryptedEnvelopeSchema, vaultSchema, kdfSchema } from '@finance-tools/contracts';
import type { DocumentContext, EncryptedEnvelope, Vault } from '@finance-tools/contracts';

const utf8 = new TextEncoder();
export function encodeBase64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error('Invalid encoding');
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  if (encodeBase64url(bytes) !== text) throw new Error('Noncanonical encoding');
  return bytes;
}
function random(size: number) {
  return crypto.getRandomValues(new Uint8Array(size));
}
function aad(context: DocumentContext): Uint8Array<ArrayBuffer> {
  if (
    !context.accountId ||
    !context.namespace ||
    !context.documentId ||
    context.schemaVersion !== 1 ||
    !Number.isSafeInteger(context.keyVersion) ||
    context.keyVersion < 1
  )
    throw new Error('Invalid context');
  return utf8.encode(
    JSON.stringify([
      'finance-tools',
      context.accountId,
      context.namespace,
      context.documentId,
      context.schemaVersion,
      context.keyVersion,
    ]),
  );
}
async function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error('Invalid key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function derivePassphraseKey(
  passphrase: string,
  input: Vault['kdf'],
): Promise<CryptoKey> {
  const kdf = kdfSchema.parse(input);
  const salt = decodeBase64url(kdf.salt);
  if (salt.length !== 16 || !passphrase || utf8.encode(passphrase).length > 4096)
    throw new Error('Invalid passphrase or salt');
  const material = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function encryptBytes(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
  context: DocumentContext,
): Promise<EncryptedEnvelope> {
  const iv = random(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(context), tagLength: 128 },
    key,
    bytes,
  );
  return encryptedEnvelopeSchema.parse({
    algorithm: 'AES-GCM',
    iv: encodeBase64url(iv),
    ciphertext: encodeBase64url(new Uint8Array(ciphertext)),
    schemaVersion: 1,
    keyVersion: context.keyVersion,
  });
}
async function decryptBytes(
  key: CryptoKey,
  input: EncryptedEnvelope,
  context: DocumentContext,
): Promise<Uint8Array<ArrayBuffer>> {
  const envelope = encryptedEnvelopeSchema.parse(input);
  if (
    envelope.keyVersion !== context.keyVersion ||
    envelope.schemaVersion !== context.schemaVersion
  )
    throw new Error('Context mismatch');
  const iv = decodeBase64url(envelope.iv),
    ciphertext = decodeBase64url(envelope.ciphertext);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid envelope');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(context), tagLength: 128 },
      key,
      ciphertext,
    ),
  );
}
function vaultContext(accountId: string, keyVersion: number, documentId: string): DocumentContext {
  return { accountId, namespace: 'vault', documentId, schemaVersion: 1, keyVersion };
}
export async function createVault(
  accountId: string,
  passphrase: string,
): Promise<{ vault: Vault; vaultKey: CryptoKey; recoverySecret: string }> {
  const raw = random(32),
    recovery = random(32);
  const kdf: Vault['kdf'] = {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 600000,
    salt: encodeBase64url(random(16)),
  };
  const vault: Vault = {
    version: 1,
    keyVersion: 1,
    kdf,
    passphraseEnvelope: await encryptBytes(
      await derivePassphraseKey(passphrase, kdf),
      raw,
      vaultContext(accountId, 1, 'passphrase'),
    ),
    recoveryEnvelope: await encryptBytes(
      await importKey(recovery),
      raw,
      vaultContext(accountId, 1, 'recovery'),
    ),
  };
  return { vault, vaultKey: await importKey(raw), recoverySecret: encodeBase64url(recovery) };
}
function validateVault(input: Vault): Vault {
  const vault = vaultSchema.parse(input);
  if (
    vault.passphraseEnvelope.keyVersion !== vault.keyVersion ||
    vault.recoveryEnvelope.keyVersion !== vault.keyVersion
  )
    throw new Error('Invalid vault versions');
  for (const envelope of [vault.passphraseEnvelope, vault.recoveryEnvelope]) {
    if (
      decodeBase64url(envelope.iv).length !== 12 ||
      decodeBase64url(envelope.ciphertext).length !== 48
    )
      throw new Error('Invalid key envelope');
  }
  decodeBase64url(vault.kdf.salt);
  return vault;
}
export async function unlockVault(
  accountId: string,
  input: Vault,
  passphrase: string,
): Promise<CryptoKey> {
  const vault = validateVault(input);
  return importKey(
    await decryptBytes(
      await derivePassphraseKey(passphrase, vault.kdf),
      vault.passphraseEnvelope,
      vaultContext(accountId, vault.keyVersion, 'passphrase'),
    ),
  );
}
export async function recoverVault(
  accountId: string,
  input: Vault,
  recoverySecret: string,
): Promise<CryptoKey> {
  const vault = validateVault(input);
  return importKey(
    await decryptBytes(
      await importKey(decodeBase64url(recoverySecret)),
      vault.recoveryEnvelope,
      vaultContext(accountId, vault.keyVersion, 'recovery'),
    ),
  );
}
// Rewrap the same raw vault key; document ciphertext and keyVersion remain unchanged.
export async function rewrapVaultPassphrase(
  accountId: string,
  input: Vault,
  credential: { passphrase: string } | { recoverySecret: string },
  newPassphrase: string,
): Promise<Vault> {
  const vault = validateVault(input);
  const recovery = 'recoverySecret' in credential;
  const wrappingKey = recovery
    ? await importKey(decodeBase64url(credential.recoverySecret))
    : await derivePassphraseKey(credential.passphrase, vault.kdf);
  const raw = await decryptBytes(
    wrappingKey,
    recovery ? vault.recoveryEnvelope : vault.passphraseEnvelope,
    vaultContext(accountId, vault.keyVersion, recovery ? 'recovery' : 'passphrase'),
  );
  const kdf = { ...vault.kdf, salt: encodeBase64url(random(16)) };
  return {
    ...vault,
    kdf,
    passphraseEnvelope: await encryptBytes(
      await derivePassphraseKey(newPassphrase, kdf),
      raw,
      vaultContext(accountId, vault.keyVersion, 'passphrase'),
    ),
  };
}
export async function encryptJson(
  key: CryptoKey,
  value: unknown,
  context: DocumentContext,
): Promise<EncryptedEnvelope> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Value is not JSON');
  return encryptBytes(key, utf8.encode(json), context);
}
export async function decryptJson<T = unknown>(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
  context: DocumentContext,
): Promise<T> {
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await decryptBytes(key, envelope, context)),
  ) as T;
}
