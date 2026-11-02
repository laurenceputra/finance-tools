import { describe, expect, it } from 'vitest';
import {
  createVault,
  unlockVault,
  recoverVault,
  rewrapVaultPassphrase,
  encryptJson,
  decryptJson,
  unwrapVaultKey,
  wrapVaultKey,
  importVaultKey,
} from './index';

describe('vault encryption', () => {
  it('converts only bounded wrapper plaintext and retains nonextractable keys and account/version binding', async () => {
    const original = await createVault('account', 'private-passphrase');
    const raw = await unwrapVaultKey('account', original.vault, original.recoverySecret, true);
    try {
      const converted = await wrapVaultKey(
        'account',
        raw,
        'next-passphrase',
        7,
        original.recoverySecret,
      );
      const metadata = { ...converted.vault, version: 2 as const, mode: 'private' as const };
      const key = await recoverVault('account', metadata, original.recoverySecret);
      expect(key.extractable).toBe(false);
      expect((await importVaultKey(raw)).extractable).toBe(false);
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
      expect(await unwrapVaultKey('account', metadata, 'next-passphrase')).toEqual(raw);
      await expect(
        recoverVault('other-account', metadata, original.recoverySecret),
      ).rejects.toThrow();
      await expect(
        recoverVault('account', { ...metadata, keyVersion: 8 }, original.recoverySecret),
      ).rejects.toThrow();
    } finally {
      raw.fill(0);
    }
  });
  it('round trips JSON, isolates contexts, and rewraps without changing document keys', async () => {
    const { vault, vaultKey, recoverySecret } = await createVault(
      'account-1',
      'long unique passphrase',
    );
    const context = {
      accountId: 'account-1',
      namespace: 'settings',
      documentId: 'prefs',
      schemaVersion: 1 as const,
      keyVersion: 1,
    };
    const envelope = await encryptJson(vaultKey, { nested: [1, null, 'text'] }, context);
    const key = await unlockVault('account-1', vault, 'long unique passphrase');
    expect(await decryptJson(key, envelope, context)).toEqual({ nested: [1, null, 'text'] });
    await expect(
      decryptJson(key, envelope, { ...context, accountId: 'account-2' }),
    ).rejects.toThrow();
    await expect(unlockVault('account-1', vault, 'wrong')).rejects.toThrow();
    const recovered = await recoverVault('account-1', vault, recoverySecret);
    expect(await decryptJson(recovered, envelope, context)).toEqual({ nested: [1, null, 'text'] });
    const rewrapped = await rewrapVaultPassphrase(
      'account-1',
      vault,
      { recoverySecret },
      'replacement passphrase',
    );
    expect(rewrapped.kdf.salt).not.toEqual(vault.kdf.salt);
    expect(
      await decryptJson(
        await unlockVault('account-1', rewrapped, 'replacement passphrase'),
        envelope,
        context,
      ),
    ).toEqual({ nested: [1, null, 'text'] });
  });
  it('rejects hostile KDF parameters before expensive derivation', async () => {
    const { vault } = await createVault('account-1', 'passphrase');
    await expect(
      unlockVault(
        'account-1',
        { ...vault, kdf: { ...vault.kdf, iterations: 2000001 } },
        'passphrase',
      ),
    ).rejects.toThrow();
    await expect(
      unlockVault(
        'account-1',
        { ...vault, passphraseEnvelope: { ...vault.passphraseEnvelope, iv: 'invalid' } },
        'passphrase',
      ),
    ).rejects.toThrow();
  });
});
