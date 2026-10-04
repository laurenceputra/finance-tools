import { describe, expect, it } from 'vitest';
import {
  createVault,
  unlockVault,
  recoverVault,
  rewrapVaultPassphrase,
  encryptJson,
  decryptJson,
} from './index';

describe('vault encryption', () => {
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
