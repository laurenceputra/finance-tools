import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SignIn, useAuth, useClerk, useSession } from '@clerk/clerk-react';
import {
  ApiFailure,
  FinanceClient,
  download,
  mergeSettings,
  previewLegacyConfig,
} from '@finance-tools/client';
import type { Storage } from '@finance-tools/client';
import type { SessionInfo, StoredDocument, ExportResponse } from '@finance-tools/contracts';
import './style.css';
import { FinancialViews } from './FinancialViews';
import { decodeBase64url } from '@finance-tools/crypto';
import { isStandardVault } from '@finance-tools/contracts';
import { StepUp } from './StepUp';
import type { MeResponse } from '@finance-tools/contracts';

type Decoded = { document: StoredDocument; value: unknown };
type ClerkSession = NonNullable<ReturnType<typeof useSession>['session']>;
type Verification = Awaited<ReturnType<ClerkSession['startVerification']>>;
type SecondFactor = NonNullable<Verification['supportedSecondFactors']>[number];
interface DeleteIntent {
  subject: string;
  sessionId: string;
  accountId: string;
  epoch: number;
}
interface IdentityBinding {
  clerkSubject: string;
  accountId?: string;
  blocked?: boolean;
}
export function App({ client, storage }: { client: FinanceClient; storage: Storage }) {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  const clerk = useClerk();
  const { session } = useSession();
  const currentUser = useRef(userId);
  currentUser.current = userId;
  const signedActor = useRef<string | null | undefined>(null);
  signedActor.current = isLoaded && isSignedIn ? userId : null;
  const currentSession = useRef(session?.id);
  currentSession.current = session?.id;
  const [binding, setBinding] = useState<IdentityBinding | null>(),
    [bootstrapping, setBootstrapping] = useState(true),
    [showSignIn, setShowSignIn] = useState(false);
  const bootstrapStarted = useRef(false),
    identityFlight = useRef(false);
  const autoAttempt = useRef<string | undefined>(undefined),
    suppressConnect = useRef(false);
  const [needsConnection, setNeedsConnection] = useState(false);
  const [principal, setPrincipal] = useState<Pick<MeResponse, 'accountId' | 'clerkSubject'>>();
  const knownSubject = principal?.clerkSubject ?? client.me?.clerkSubject ?? binding?.clerkSubject;
  const mismatch = !!(isLoaded && isSignedIn && userId && knownSubject && knownSubject !== userId);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [tab, setTab] = useState('Overview'),
    [locked, setLocked] = useState(true),
    [history, setHistory] = useState<Decoded[]>([]),
    [settings, setSettings] = useState<Decoded[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [credential, setCredential] = useState(''),
    [newPassphrase, setNewPassphrase] = useState(''),
    [recovery, setRecovery] = useState(false),
    [remember, setRemember] = useState(false);
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof client.prepareVault>>>(),
    [downloaded, setDownloaded] = useState(false),
    [ack, setAck] = useState(false);
  const [privatePrepared, setPrivatePrepared] =
    useState<Awaited<ReturnType<typeof client.preparePrivate>>>();
  const [modeAction, setModeAction] = useState<'private' | 'standard'>();
  const [trustServer, setTrustServer] = useState(false);
  const [pairId, setPairId] = useState(new URLSearchParams(location.search).get('pairingId') ?? ''),
    [code, setCode] = useState(new URLSearchParams(location.search).get('code') ?? ''),
    [pair, setPair] = useState<{
      client: { name: string; namespaces: string[]; products: string[] };
    }>();
  const [settingsProduct, setSettingsProduct] = useState<'portfolio' | 'bank-subcaps'>('portfolio');
  const settingsId = `current_${settingsProduct}`;
  const [restoreCredential, setRestoreCredential] = useState(''),
    [restoreRecovery, setRestoreRecovery] = useState(false);
  const [settingText, setSettingText] = useState('{}');
  const [deleteCode, setDeleteCode] = useState(''),
    [deleteSubject, setDeleteSubject] = useState<string>(),
    [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [secondFactors, setSecondFactors] = useState<SecondFactor[]>([]),
    [secondFactorIndex, setSecondFactorIndex] = useState(0),
    [secondCode, setSecondCode] = useState(''),
    [phonePrepared, setPhonePrepared] = useState(false),
    [deleteStep, setDeleteStep] = useState<'email' | 'second'>('email');
  const deleteIntent = useRef<DeleteIntent | undefined>(undefined);
  function cancelDeletion() {
    deleteIntent.current = undefined;
    setDeleteSubject(undefined);
    setDeleteCode('');
    setDeleteConfirmation('');
    setSecondFactors([]);
    setSecondCode('');
    setPhonePrepared(false);
    setDeleteStep('email');
  }
  function guardDeletion(intent: DeleteIntent) {
    if (
      deleteIntent.current !== intent ||
      currentUser.current !== intent.subject ||
      currentSession.current !== intent.sessionId ||
      client.me?.accountId !== intent.accountId ||
      client.lockEpoch !== intent.epoch
    )
      throw new Error('Deletion cancelled: account, session or verification intent changed');
  }
  async function finishDeletion(intent: DeleteIntent) {
    guardDeletion(intent);
    const token = await freshClerkToken();
    guardDeletion(intent);
    await client.request('/account', 'DELETE', { clerkToken: token, confirmation: 'DELETE' }, () =>
      guardDeletion(intent),
    );
    guardDeletion(intent);
    await client.forgetSession();
    setReady(false);
    cancelDeletion();
    await clerk.signOut();
  }
  useEffect(() => {
    cancelDeletion();
  }, [userId, session?.id]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed. Try again.');
    } finally {
      setBusy(false);
      setLocked(!client.unlocked);
      setReady(!!client.me);
    }
  };
  useEffect(() => {
    const channel =
      typeof BroadcastChannel === 'undefined'
        ? undefined
        : new BroadcastChannel('finance-vault-lock');
    let remoteLock = false;
    client.onLock = (propagate = true) => {
      setLocked(true);
      setHistory([]);
      setSettings([]);
      setSettingText('{}');
      setPrepared(undefined);
      setPrivatePrepared(undefined);
      setModeAction(undefined);
      setCredential('');
      setNewPassphrase('');
      setRestoreCredential('');
      setPair(undefined);
      setSessions([]);
      cancelDeletion();
      if (!remoteLock && propagate) channel?.postMessage('lock');
    };
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === 'lock') {
          remoteLock = true;
          void client.lock().finally(() => {
            remoteLock = false;
          });
        }
      };
    return () => {
      channel?.close();
      client.onLock = () => {};
    };
  }, []);
  async function readBinding(): Promise<IdentityBinding | null> {
    const value = await storage.get<IdentityBinding>('identity-binding');
    if (value) return value;
    const legacy = await storage.get<string>('clerk-subject');
    return legacy ? { clerkSubject: legacy } : null;
  }
  function assertIdentity(me: MeResponse) {
    if (!me.clerkSubject)
      throw new Error('Finance identity metadata is unavailable. Retry session restoration.');
    setPrincipal({ accountId: me.accountId, clerkSubject: me.clerkSubject });
    if (signedActor.current && me.clerkSubject !== signedActor.current)
      throw new Error('Finance session identity changed. Connect the intended signed-in account.');
  }
  async function restoreSession() {
    const value = await readBinding();
    setBinding(value);
    if (value?.blocked) return;
    try {
      await client.initialize(assertIdentity);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) {
        setNeedsConnection(true);
        setShowSignIn(true);
        return;
      }
      throw error;
    }
    if (!client.me) return;
    assertIdentity(client.me);
    const verifiedBinding = {
      clerkSubject: client.me.clerkSubject,
      accountId: client.me.accountId,
    };
    await storage.set('identity-binding', verifiedBinding);
    assertIdentity(client.me);
    setBinding(verifiedBinding);
    setReady(!!client.me);
    setLocked(!client.unlocked);
    if (client.unlocked) await loadData();
  }
  useEffect(() => {
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;
    // The Finance refresh cookie is independent of Clerk's lifetime/loading state.
    void run(restoreSession).finally(() => setBootstrapping(false));
  }, []);
  useLayoutEffect(() => {
    if (!mismatch || (bootstrapping && !principal && !client.me) || identityFlight.current) return;
    identityFlight.current = true;
    setReady(false);
    // This is an actual different signed-in identity, not Clerk expiration/sign-out.
    const old = principal
      ? { clerkSubject: principal.clerkSubject, accountId: principal.accountId }
      : binding;
    const disconnected = client.disconnect().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    void run(async () => {
      await storage.set('identity-binding', { ...(old ?? { clerkSubject: '' }), blocked: true });
      const result = await disconnected;
      setBinding(old ? { ...old, blocked: true } : null);
      if (result.error) throw result.error;
      setNotice(
        'Clerk identity changed. Old Finance data and remembered keys were cleared. Connect this identity explicitly.',
      );
    }).finally(() => {
      identityFlight.current = false;
    });
  }, [mismatch, bootstrapping, principal]);
  useEffect(() => {
    if (
      bootstrapping ||
      ready ||
      !needsConnection ||
      !isLoaded ||
      !isSignedIn ||
      !userId ||
      mismatch ||
      binding?.blocked ||
      suppressConnect.current ||
      autoAttempt.current === userId
    )
      return;
    autoAttempt.current = userId;
    void run(connectBrowser);
  }, [bootstrapping, ready, needsConnection, isLoaded, isSignedIn, userId, mismatch, binding]);
  useEffect(() => {
    if (tab !== 'Sessions' || !ready || mismatch) return;
    void run(async () =>
      setSessions((await client.request<{ sessions: SessionInfo[] }>('/sessions')).sessions),
    );
  }, [tab, ready, mismatch]);
  async function loadData(more = false) {
    if (client.me) assertIdentity(client.me);
    const epoch = client.lockEpoch;
    const page =
      !more && tab === 'Overview'
        ? { documents: await client.all('history'), cursor: null }
        : await client.list('history', more ? (cursor ?? undefined) : undefined);
    const decoded = await Promise.all(
      page.documents.map(async (document) => ({ document, value: await client.decrypt(document) })),
    );
    if (client.lockEpoch !== epoch || !client.unlocked) return;
    if (client.me) assertIdentity(client.me);
    setHistory((old) => (more ? [...old, ...decoded] : decoded));
    setCursor(page.cursor);
    if (!more) {
      const docs = await client.all('settings');
      const current = await Promise.all(
        docs.map(async (document) => ({ document, value: await client.decrypt(document) })),
      );
      if (client.lockEpoch !== epoch || !client.unlocked) return;
      if (client.me) assertIdentity(client.me);
      setSettings(current);
      setSettingText(
        JSON.stringify(current.find((x) => x.document.id === settingsId)?.value ?? {}, null, 2),
      );
    }
  }
  async function restoreFile(file: File) {
    const epoch = client.lockEpoch,
      secret = restoreCredential;
    setRestoreCredential('');
    if (!secret)
      throw new Error(
        'Enter the backup vault passphrase or recovery secret before choosing a file',
      );
    if (file.size > 64 * 1024 * 1024)
      throw new Error(
        'Maximum encrypted backup size is 64 MiB; larger backups require a streaming restore tool',
      );
    const input = JSON.parse(await file.text()) as ExportResponse;
    if (client.lockEpoch !== epoch) throw new Error('Restore cancelled by account switch or lock');
    await client.restore(input, secret, restoreRecovery);
    if (client.lockEpoch !== epoch) return;
    setNotice(
      'Restore complete. Backup authenticated before mutation. Interrupted restores can resume using the identical file.',
    );
  }
  async function freshClerkToken() {
    if (!isLoaded || !isSignedIn || !userId) {
      setShowSignIn(true);
      throw new Error(
        'Sign in with Clerk for this explicit connection or sensitive action. Your existing Finance session is unchanged.',
      );
    }
    const subject = userId,
      sessionId = session?.id,
      epoch = client.lockEpoch;
    const token = await getToken({ skipCache: true });
    if (
      !token ||
      !subject ||
      currentUser.current !== subject ||
      currentSession.current !== sessionId ||
      epoch !== client.lockEpoch
    )
      throw new Error('Authentication changed. Start this action again.');
    let tokenSubject: unknown;
    try {
      tokenSubject = JSON.parse(new TextDecoder().decode(decodeBase64url(token.split('.')[1]))).sub;
    } catch {
      throw new Error('Invalid Clerk authentication response');
    }
    if (tokenSubject !== subject)
      throw new Error('Clerk token belongs to a different signed-in subject');
    return token;
  }
  async function connectBrowser() {
    const subject = userId,
      token = await freshClerkToken();
    if (!subject) throw new Error('Sign in again');
    await client.exchange(token, assertIdentity);
    if (currentUser.current !== subject || !client.me) {
      await client.forgetSession();
      throw new Error('Identity changed during connection');
    }
    const value = { clerkSubject: subject, accountId: client.me.accountId };
    if (client.me.clerkSubject !== subject) {
      await client.forgetSession();
      throw new Error('Finance session subject does not match Clerk');
    }
    setPrincipal(value);
    await storage.set('identity-binding', value);
    if (currentUser.current !== subject) {
      await client.forgetSession();
      return;
    }
    setBinding(value);
    setShowSignIn(false);
    setReady(true);
    setLocked(!client.unlocked);
    setNeedsConnection(false);
    if (client.unlocked) await loadData();
  }
  async function logout(all = false) {
    suppressConnect.current = true;
    const blocked = { ...(binding ?? { clerkSubject: '' }), blocked: true };
    await storage.set('identity-binding', blocked);
    setBinding(blocked);
    try {
      await client.disconnect(all);
    } finally {
      setReady(false);
      await clerk.signOut();
    }
  }
  const button = (label: string, action: () => Promise<void>, danger = false, enabled = true) => (
    <button
      disabled={busy || !enabled}
      className={danger ? 'danger' : ''}
      onClick={() => void run(action)}
    >
      {label}
    </button>
  );
  if (bootstrapping)
    return (
      <main>
        <h1>Finance</h1>
        <p>Restoring your Finance session…</p>
      </main>
    );
  return (
    <div className="shell">
      <header>
        <div>
          <span className="eyebrow">FINANCE TOOLS</span>
          <h1>Your dashboard</h1>
        </div>
        <span className="badge">
          {mismatch
            ? 'Identity change required'
            : ready
              ? locked
                ? 'Vault locked'
                : 'Vault unlocked'
              : 'Not connected'}
        </span>
      </header>
      {ready && !mismatch && (
        <nav>
          {(locked
            ? ['Vault', 'Sessions', 'Export & account']
            : [
                'Overview',
                'History',
                'Settings',
                'Vault',
                'Pair a script',
                'Sessions',
                'Export & account',
              ]
          ).map((name) => (
            <button
              key={name}
              className={tab === name ? 'active' : ''}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>
      )}
      <main aria-busy={busy}>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        <section aria-label="Authentication status">
          <p>
            {ready && !mismatch
              ? 'Your Finance session is active independently of Clerk sign-in.'
              : 'Sign in with Clerk to open Finance; new accounts use recoverable Standard encryption.'}{' '}
            {!isLoaded
              ? 'Clerk is loading; existing Finance access does not depend on it.'
              : !isSignedIn
                ? 'Clerk is signed out. Existing Finance history and vault access still work.'
                : `Clerk identity: ${userId}`}
          </p>
          {(!isSignedIn || showSignIn) && (
            <button onClick={() => setShowSignIn((value) => !value)}>
              {showSignIn ? 'Close Clerk sign-in' : 'Sign in / reauthenticate with Clerk'}
            </button>
          )}
          {showSignIn && isLoaded && !isSignedIn && (
            <SignIn
              routing="hash"
              forceRedirectUrl={location.origin + location.pathname + location.search}
            />
          )}
          {showSignIn && isSignedIn && (
            <p>
              For a different identity, explicitly sign out and sign in with Clerk, then connect it.
              Account deletion below requires a fresh factor verification.
            </p>
          )}
        </section>
        {!ready || mismatch ? (
          <section>
            <h2>{isSignedIn ? 'Connect your browser' : 'Sign in to Finance'}</h2>
            <p>
              Sign in to continue automatically. After a transient connection failure, retry your
              existing Finance session, even if Clerk expired. Explicit reconnect is available if
              needed. A real different signed-in identity requires confirmation; old views clear
              first.
            </p>
            {button('Retry existing session renewal', restoreSession)}
            {isSignedIn && button('Connect this browser', connectBrowser)}
          </section>
        ) : (
          <>
            <div className="toolbar">
              <small>Account: {client.me?.accountId}</small>
              <button onClick={() => void run(() => client.lock())}>
                Lock & forget this device
              </button>
              {button('Sign out', () => logout())}
            </div>
            {(tab === 'Vault' || locked) && client.vault && isStandardVault(client.vault.vault) && (
              <section>
                <h2>Standard encryption</h2>
                <p>
                  Your encrypted data key is recoverable by this service after sign-in. No separate
                  vault password is needed. Private mode removes the active server key wrap; it
                  cannot erase prior backups or cached keys.
                </p>
                {locked &&
                  button('Unlock Standard vault', async () => {
                    await client.loadVault();
                    await client.unlockStandard();
                    await loadData();
                  })}
                {!locked && (
                  <>
                    <label>
                      Private-mode passphrase
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={newPassphrase}
                        onChange={(event) => setNewPassphrase(event.target.value)}
                      />
                    </label>
                    {button('Prepare Private key file', async () => {
                      setPrivatePrepared(await client.preparePrivate(newPassphrase));
                      setNewPassphrase('');
                      setDownloaded(false);
                      setAck(false);
                    })}
                    <label>
                      Or reuse an account-bound Private key file
                      <input
                        type="file"
                        accept="application/json"
                        disabled={busy || newPassphrase.length < 12}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (file)
                            void run(async () => {
                              if (file.size > 8192) throw new Error('Key file limit is 8 KiB');
                              const epoch = client.lockEpoch,
                                input: unknown = JSON.parse(await file.text());
                              if (epoch !== client.lockEpoch) return;
                              setPrivatePrepared(await client.preparePrivate(newPassphrase, input));
                              setNewPassphrase('');
                              setDownloaded(false);
                              setAck(false);
                            });
                        }}
                      />
                    </label>
                    {privatePrepared && (
                      <div className="warning">
                        <p>
                          Store this key file offline. Anyone with the file can decrypt your
                          finances. Losing both it and your passphrase is unrecoverable.
                        </p>
                        <button
                          onClick={() => {
                            download('finance-private-key.json', privatePrepared.keyFile);
                            setDownloaded(true);
                          }}
                        >
                          Download Private key file
                        </button>
                        <label>
                          <input
                            type="checkbox"
                            checked={ack}
                            onChange={(event) => setAck(event.target.checked)}
                          />
                          I saved my key file securely.
                        </label>
                        <button
                          disabled={busy || !downloaded || !ack}
                          onClick={() => setModeAction('private')}
                        >
                          Verify & enable Private mode
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
            {(tab === 'Vault' || locked) &&
              (!client.vault || !isStandardVault(client.vault.vault)) && (
                <section>
                  <h2>{client.vault ? 'Unlock your vault' : 'Vault setup / unlock'}</h2>
                  <p>
                    Private mode: bring your key file on each new device, or use your existing
                    passphrase/recovery secret. The service cannot recover this key.
                  </p>
                  <label>
                    Import Private key / legacy recovery file
                    <input
                      type="file"
                      accept="application/json"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file)
                          void run(async () => {
                            if (file.size > 8192) throw new Error('Key file limit is 8 KiB');
                            const epoch = client.lockEpoch,
                              value: unknown = JSON.parse(await file.text());
                            if (epoch !== client.lockEpoch) return;
                            await client.unlockKeyFile(value, remember);
                            await loadData();
                          });
                      }}
                    />
                  </label>
                  <p>
                    Passphrases never leave this device. Remembering a key grants indefinite access
                    on this device until you lock or disconnect.
                  </p>
                  <label>
                    {recovery ? 'Recovery secret' : 'Passphrase'}
                    <input
                      type="password"
                      autoComplete="off"
                      value={credential}
                      onChange={(e) => setCredential(e.target.value)}
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={recovery}
                      onChange={(e) => setRecovery(e.target.checked)}
                    />
                    Use recovery secret
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                    />
                    Remember vault key on this device (no expiry)
                  </label>
                  {button(
                    'Unlock existing vault',
                    async () => {
                      const secret = credential;
                      setCredential('');
                      await client.unlock(secret, recovery, remember);
                      await loadData();
                    },
                    false,
                    !!credential,
                  )}
                  {!client.vault && (
                    <>
                      {button('Prepare new vault', async () => {
                        if (credential.length < 12)
                          throw new Error('Use a passphrase of at least 12 characters');
                        const secret = credential;
                        setCredential('');
                        setPrepared(await client.prepareVault(secret));
                        setDownloaded(false);
                        setAck(false);
                      })}
                      {prepared && (
                        <div className="warning">
                          <h3>Save your recovery material before continuing</h3>
                          <p>
                            If you lose your passphrase and recovery secret, your data cannot be
                            recovered. The recovery file unlocks your finances: store it offline,
                            never share it.
                          </p>
                          <button
                            onClick={() => {
                              if (
                                prepared.accountId !== client.me?.accountId ||
                                prepared.epoch !== client.lockEpoch
                              ) {
                                setPrepared(undefined);
                                setError(
                                  'Prepared recovery material belongs to a previous account or lock epoch',
                                );
                                return;
                              }
                              download('finance-recovery.json', {
                                version: 1,
                                accountId: prepared.accountId,
                                recoverySecret: prepared.recoverySecret,
                              });
                              setDownloaded(true);
                            }}
                          >
                            Download recovery file
                          </button>
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={ack}
                              onChange={(e) => setAck(e.target.checked)}
                            />
                            I saved the recovery file securely.
                          </label>
                          <button
                            disabled={busy || !downloaded || !ack}
                            onClick={() =>
                              void run(async () => {
                                await client.finishVault(prepared);
                                setPrepared(undefined);
                                await loadData();
                              })
                            }
                          >
                            Finish vault creation
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {!locked && (
                    <>
                      <label>
                        New passphrase
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={newPassphrase}
                          onChange={(e) => setNewPassphrase(e.target.value)}
                        />
                      </label>
                      {button('Change passphrase (same vault key)', async () => {
                        if (newPassphrase.length < 12)
                          throw new Error('Use at least 12 characters');
                        const old = credential,
                          next = newPassphrase;
                        setCredential('');
                        setNewPassphrase('');
                        await client.rewrap(old, next, recovery);
                        setNotice(
                          'Passphrase changed. Existing encrypted documents are unchanged.',
                        );
                      })}
                      <label>
                        <input
                          type="checkbox"
                          checked={trustServer}
                          onChange={(event) => setTrustServer(event.target.checked)}
                        />
                        I trust this service to recover my encryption key after sign-in (Standard
                        mode).
                      </label>
                      <button
                        disabled={busy || !trustServer || !credential}
                        onClick={() => setModeAction('standard')}
                      >
                        Verify & enable Standard mode
                      </button>
                    </>
                  )}
                </section>
              )}
            {modeAction && (
              <StepUp
                session={session}
                onCancel={() => setModeAction(undefined)}
                onVerified={async (assertCurrent) => {
                  const action = modeAction,
                    prepared = privatePrepared,
                    secret = credential,
                    epoch = client.lockEpoch;
                  const token = await freshClerkToken();
                  assertCurrent();
                  if (epoch !== client.lockEpoch) throw new Error('Mode change cancelled by lock');
                  if (action === 'private') {
                    if (!prepared || !downloaded || !ack)
                      throw new Error('Save and confirm your key file first');
                    await client.finishPrivate(prepared, token, assertCurrent);
                  } else
                    await client.enableStandard(
                      secret,
                      recovery,
                      token,
                      trustServer,
                      assertCurrent,
                    );
                  setCredential('');
                  setModeAction(undefined);
                  setPrivatePrepared(undefined);
                  setLocked(true);
                  setNotice('Encryption mode changed. Unlock deliberately to continue.');
                }}
              />
            )}
            {!locked && tab === 'Overview' && (
              <section>
                <h2>Portfolio & bank snapshots</h2>
                <p className="warning">
                  Captured snapshots can be stale or incomplete. Values are not live balances or
                  investment advice. Check source, currency and capture time before making
                  decisions.
                </p>
                {button('Refresh decrypted views', async () => loadData())}
                <FinancialViews
                  values={history.map((x) => x.value)}
                  settings={settings.find((x) => x.document.id === 'current_portfolio')?.value}
                  bankSettings={
                    settings.find((x) => x.document.id === 'current_bank-subcaps')?.value
                  }
                />
                <Install />
              </section>
            )}
            {!locked && tab === 'History' && (
              <section>
                <h2>History</h2>
                <p>
                  Account-scoped encrypted snapshots. Server and local history retention: three
                  calendar months.
                </p>
                {button('Refresh history', async () => loadData())}
                {history.map((x) => (
                  <article key={x.document.id}>
                    <h3>{x.document.id}</h3>
                    <small>
                      {x.document.occurredAt} · revision {x.document.revision}
                    </small>
                    <pre>{JSON.stringify(x.value, null, 2)}</pre>
                  </article>
                ))}
                {cursor && button('Load next page', async () => loadData(true))}
                {!history.length && (
                  <p>
                    No snapshots yet. Connect a userscript and capture data on a supported portal.
                  </p>
                )}
              </section>
            )}
            {!locked && tab === 'Settings' && (
              <section>
                <h2>Allocation targets / legacy migration</h2>
                <p>
                  Portfolio allocation settings use allocations.scopes[]. Each scope requires id,
                  bucket, accountId, accountType (CPF/SRS/cash/unknown), currency and section
                  (asset/liability), optional goalId/projectedDeposit, and targets keyed by holding
                  ID. Targets accept targetBps (0–10000) or targetAmount {`{minor,currency}`}, fixed
                  or excluded. Overview calculates actual/target balances, drift in basis points and
                  target-minus-actual, without mixing accounts/currencies/liabilities or claiming
                  time-weighted returns.
                </p>
                <h3>Import legacy local configuration</h3>
                <p>
                  Explicit source/product: <strong>{settingsProduct}</strong> (choose product in the
                  editor below). Export decrypted configuration using the old tool, then choose its
                  JSON file. No old encrypted remote login or email-based account matching.
                  Migration creates a separate encrypted review document. Legacy portfolio codes
                  require explicit current holding/account target mapping; bank templates require
                  explicit current bound account IDs.
                </p>
                <input
                  type="file"
                  accept="application/json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file)
                      void run(async () => {
                        if (file.size > 2 * 1024 * 1024)
                          throw new Error('Legacy configuration limit is 2 MiB');
                        const epoch = client.lockEpoch,
                          origin = settingsProduct,
                          value = JSON.parse(await file.text());
                        if (epoch !== client.lockEpoch) return;
                        const mapping =
                          origin === 'bank-subcaps'
                            ? (JSON.parse(
                                prompt(
                                  'Legacy card-name → current bound account ID JSON ({} keeps unapplied templates)',
                                  '{}',
                                ) ?? '{}',
                              ) as Record<string, string>)
                            : {};
                        const preview = previewLegacyConfig(value, origin, mapping);
                        if (
                          !confirm(
                            `Import separate ${origin} review? ${preview.warnings.join(', ')}`,
                          )
                        )
                          return;
                        await client.put(
                          'settings',
                          `legacy_${crypto.randomUUID()}`,
                          preview.settings,
                          0,
                          undefined,
                          undefined,
                          origin,
                        );
                        await loadData();
                        setNotice(`Legacy review imported: ${preview.warnings.join(', ')}`);
                      });
                  }}
                />
              </section>
            )}
            {!locked && tab === 'Settings' && (
              <section>
                <h2>Product-scoped categorization settings</h2>
                <label>
                  Product
                  <select
                    disabled={busy}
                    value={settingsProduct}
                    onChange={(e) => {
                      const product = e.target.value as 'portfolio' | 'bank-subcaps';
                      setSettingsProduct(product);
                      setSettingText(
                        JSON.stringify(
                          settings.find((x) => x.document.id === `current_${product}`)?.value ?? {},
                          null,
                          2,
                        ),
                      );
                    }}
                  >
                    <option value="portfolio">Portfolio</option>
                    <option value="bank-subcaps">Bank subcaps</option>
                  </select>
                </label>
                <p>
                  Independent edits are reconciled; same-field conflicts require review. Portfolio
                  categories: {`{"assignments":{"holding-id":"category"}}`}. Bank reference rules:{' '}
                  {`{"cards":{"account-id":{"selectedCategories":["Dining"],"merchantMap":{"MERCHANT*":"Dining"}}}}`}
                  . Reference bank rules are UNVERIFIED; verify with the issuer.
                </p>
                <textarea
                  rows={16}
                  value={settingText}
                  onChange={(e) => setSettingText(e.target.value)}
                />
                {button('Save current settings', async () => {
                  const value: unknown = JSON.parse(settingText);
                  const current = settings.find((x) => x.document.id === settingsId);
                  await client.put(
                    'settings',
                    settingsId,
                    value,
                    current?.document.revision ?? 0,
                    undefined,
                    (remote, local) => mergeSettings(current?.value ?? {}, remote, local),
                    settingsProduct,
                  );
                  await loadData();
                  setNotice('Settings saved.');
                })}
                {button('Reload latest settings', async () => loadData())}
                {settings
                  .filter((x) => x.document.id !== settingsId)
                  .map((x) => (
                    <details key={x.document.id}>
                      <summary>Review {x.document.id}</summary>
                      <pre>{JSON.stringify(x.value, null, 2)}</pre>
                      <button
                        disabled={busy}
                        onClick={() => setSettingText(JSON.stringify(x.value, null, 2))}
                      >
                        Copy to editor (not saved yet)
                      </button>
                    </details>
                  ))}
              </section>
            )}
            {tab === 'Pair a script' && (
              <section>
                <h2>Approve a userscript</h2>
                <p>
                  Enter both the pairing ID and eight-digit code shown in the script. Approving
                  grants only the displayed scopes/products; no vault key is transferred.
                </p>
                <label>
                  Pairing ID
                  <input
                    disabled={busy}
                    value={pairId}
                    onChange={(e) => {
                      setPairId(e.target.value);
                      setPair(undefined);
                    }}
                  />
                </label>
                <label>
                  Code
                  <input
                    disabled={busy}
                    inputMode="numeric"
                    maxLength={8}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                      setPair(undefined);
                    }}
                  />
                </label>
                {button(
                  'Inspect requested access',
                  async () => {
                    const epoch = client.lockEpoch,
                      result = await client.request<{
                        client: { name: string; namespaces: string[]; products: string[] };
                      }>('/pairing/inspect', 'POST', { pairingId: pairId, code });
                    if (epoch === client.lockEpoch) setPair(result);
                  },
                  false,
                  !!pairId && /^[0-9]{8}$/.test(code),
                )}
                {pair && (
                  <div className="warning">
                    <h3>{pair.client.name}</h3>
                    <p>
                      Requested scopes: {pair.client.namespaces.join(', ')} · Products:{' '}
                      {pair.client.products.join(', ')}
                    </p>
                    {button('Approve this exact request', async () => {
                      await client.request('/pairing/approve', 'POST', { pairingId: pairId, code });
                      setPair(undefined);
                      setNotice('Approved. Return to the script and redeem before it expires.');
                    })}
                  </div>
                )}
              </section>
            )}
            {tab === 'Sessions' && (
              <section>
                <h2>Connected devices</h2>
                {button('Load sessions', async () => {
                  setSessions(
                    (await client.request<{ sessions: SessionInfo[] }>('/sessions')).sessions,
                  );
                })}
                {sessions.map((session) => (
                  <article key={session.id}>
                    <h3>
                      {session.client.name} {session.current && '(this session)'}
                    </h3>
                    <p>
                      {session.client.namespaces.join(', ')} · Last active {session.lastUsedAt}
                    </p>
                    <small>
                      Idle expiry {session.idleExpiresAt} · Absolute expiry{' '}
                      {session.absoluteExpiresAt}
                    </small>
                    {button(
                      'Revoke session',
                      async () => {
                        await client.request(`/sessions/${session.id}`, 'DELETE');
                        setSessions((old) => old.filter((x) => x.id !== session.id));
                        if (session.current) {
                          await client.forgetSession();
                          setReady(false);
                        }
                      },
                      true,
                    )}
                  </article>
                ))}
                {button(
                  'Revoke all sessions',
                  async () => {
                    await logout(true);
                  },
                  true,
                )}
              </section>
            )}
            {tab === 'Export & account' && (
              <section>
                <h2>Data portability</h2>
                {button('Download encrypted backup', async () => {
                  const passphrase =
                    client.vault && isStandardVault(client.vault.vault)
                      ? prompt(
                          'Set a backup-only passphrase (at least 12 characters). Keep it separately; this backup cannot use server recovery.',
                        )
                      : undefined;
                  if (passphrase === null) return;
                  download('finance-encrypted.json', await client.encryptedExport(passphrase));
                })}
                {!locked &&
                  button('Download decrypted data (sensitive)', async () => {
                    if (!confirm('This file contains plaintext financial data. Save it securely?'))
                      return;
                    download('finance-decrypted.json', await client.decryptedExport());
                  })}
                <h3>Restore encrypted backup</h3>
                <p>
                  Maximum 64 MiB. Authenticates the backup vault and every document before mutation.
                  Empty same-account vault only, or resume the identical interrupted backup; no
                  overwrite. Larger backups require streaming tooling.
                </p>
                <label>
                  Backup vault passphrase / recovery secret
                  <input
                    type="password"
                    autoComplete="off"
                    value={restoreCredential}
                    onChange={(e) => setRestoreCredential(e.target.value)}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={restoreRecovery}
                    onChange={(e) => setRestoreRecovery(e.target.checked)}
                  />
                  Use recovery secret
                </label>
                <input
                  type="file"
                  accept="application/json"
                  disabled={busy || !restoreCredential}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void run(() => restoreFile(file));
                  }}
                />
                {!locked && (
                  <>
                    <h3>Import fresh decrypted export</h3>
                    <p>
                      Reencrypts locally into fresh import IDs, never overwrites current settings or
                      history. Imported settings are separate documents for review; expired history
                      is skipped. Input files contain plaintext financial data.
                    </p>
                    <input
                      type="file"
                      accept="application/json"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file)
                          void run(async () => {
                            if (file.size > 64 * 1024 * 1024) throw new Error('Maximum 64 MiB');
                            const epoch = client.lockEpoch;
                            const value = JSON.parse(await file.text());
                            if (epoch !== client.lockEpoch) return;
                            await client.importDecrypted(value);
                            setNotice(
                              'Imported with fresh IDs. Review imported settings before applying them to current.',
                            );
                          });
                      }}
                    />
                  </>
                )}
                <h2 className="danger-text">Delete account</h2>
                <p>
                  Irreversible. Requires a fresh Clerk email verification for this signed-in
                  subject, then a fresh token. Merely refreshing a token is not reauthentication.
                  Clerk email-code verification must be enabled. Enrolled MFA requires a fresh
                  authenticator code, backup code or supported phone code as a second factor.
                  Unsupported factors fail closed; no token is fetched until verification completes.
                </p>
                {button(
                  'Send fresh verification code',
                  async () => {
                    if (!session || !userId || !isSignedIn) {
                      setShowSignIn(true);
                      throw new Error(
                        'Sign in with Clerk before account-deletion verification. Your Finance session is unchanged.',
                      );
                    }
                    cancelDeletion();
                    if (!client.me) throw new Error('Connect the Finance account first');
                    const intent = {
                      epoch: client.lockEpoch,
                      subject: userId,
                      sessionId: session.id,
                      accountId: client.me.accountId,
                    };
                    deleteIntent.current = intent;
                    const verification = await session.startVerification({ level: 'multi_factor' });
                    guardDeletion(intent);
                    const factor = verification.supportedFirstFactors?.find(
                      (factor) => factor.strategy === 'email_code',
                    );
                    if (!factor || factor.strategy !== 'email_code')
                      throw new Error(
                        'Email reverification is unavailable for this account. Enable it in Clerk before deleting.',
                      );
                    await session.prepareFirstFactorVerification({
                      strategy: 'email_code',
                      emailAddressId: factor.emailAddressId,
                    });
                    guardDeletion(intent);
                    setDeleteSubject(userId);
                    setNotice('A fresh verification code was sent.');
                  },
                  true,
                )}
                {!deleteSubject && deleteIntent.current && (
                  <button
                    onClick={() => {
                      cancelDeletion();
                      setNotice('Account deletion cancelled. No deletion request will be sent.');
                    }}
                  >
                    Cancel account deletion
                  </button>
                )}
                {deleteSubject && (
                  <>
                    <label>
                      Fresh email verification code
                      <input
                        value={deleteCode}
                        disabled={busy || deleteStep !== 'email'}
                        autoComplete="one-time-code"
                        onChange={(e) => setDeleteCode(e.target.value)}
                      />
                    </label>
                    <label>
                      Type DELETE
                      <input
                        value={deleteConfirmation}
                        disabled={busy}
                        onChange={(e) => setDeleteConfirmation(e.target.value)}
                      />
                    </label>
                    {deleteStep === 'email' &&
                      button(
                        'Verify email & continue deletion',
                        async () => {
                          const intent = deleteIntent.current;
                          if (
                            !intent ||
                            !session ||
                            userId !== deleteSubject ||
                            deleteConfirmation !== 'DELETE'
                          )
                            throw new Error('Confirm DELETE for the same signed-in account');
                          guardDeletion(intent);
                          const verification = await session.attemptFirstFactorVerification({
                            strategy: 'email_code',
                            code: deleteCode,
                          });
                          setDeleteCode('');
                          guardDeletion(intent);
                          if (verification.status === 'complete') {
                            await finishDeletion(intent);
                            return;
                          }
                          if (verification.status !== 'needs_second_factor')
                            throw new Error(
                              'Email verification did not complete. Start verification again.',
                            );
                          const factors = (verification.supportedSecondFactors ?? []).filter(
                            (factor) =>
                              ['totp', 'backup_code', 'phone_code'].includes(factor.strategy),
                          );
                          setDeleteStep('second');
                          setSecondFactors(factors);
                          setSecondFactorIndex(0);
                          setSecondCode('');
                          setPhonePrepared(false);
                          if (!factors.length)
                            throw new Error(
                              'No supported enrolled second factor is available. This UI supports TOTP, backup codes and Clerk phone codes only; deletion remains blocked.',
                            );
                          setNotice(
                            'Email verified. Complete your enrolled second factor before deletion.',
                          );
                        },
                        true,
                      )}
                    {deleteStep === 'second' && (
                      <>
                        <label>
                          Second-factor method
                          <select
                            disabled={busy}
                            value={secondFactorIndex}
                            onChange={(event) => {
                              setSecondFactorIndex(Number(event.target.value));
                              setSecondCode('');
                              setPhonePrepared(false);
                            }}
                          >
                            {secondFactors.map((factor, index) => (
                              <option key={index} value={index}>
                                {factor.strategy === 'totp'
                                  ? 'Authenticator (TOTP)'
                                  : factor.strategy === 'backup_code'
                                    ? 'Backup code'
                                    : `Phone code · ${factor.strategy === 'phone_code' ? factor.safeIdentifier : ''}`}
                              </option>
                            ))}
                          </select>
                        </label>
                        {secondFactors[secondFactorIndex]?.strategy === 'phone_code' &&
                          button('Send second-factor phone code', async () => {
                            const intent = deleteIntent.current,
                              factor = secondFactors[secondFactorIndex];
                            if (!intent || !session || factor?.strategy !== 'phone_code')
                              throw new Error('Select an enrolled phone factor');
                            guardDeletion(intent);
                            await session.prepareSecondFactorVerification({
                              strategy: 'phone_code',
                              phoneNumberId: factor.phoneNumberId,
                            });
                            guardDeletion(intent);
                            setPhonePrepared(true);
                            setNotice(`A second-factor code was sent to ${factor.safeIdentifier}.`);
                          })}
                        <label>
                          Second-factor code
                          <input
                            disabled={busy}
                            value={secondCode}
                            autoComplete="one-time-code"
                            type={
                              secondFactors[secondFactorIndex]?.strategy === 'backup_code'
                                ? 'password'
                                : 'text'
                            }
                            onChange={(event) => setSecondCode(event.target.value)}
                          />
                        </label>
                        {button(
                          'Verify MFA & permanently delete',
                          async () => {
                            const intent = deleteIntent.current,
                              factor = secondFactors[secondFactorIndex];
                            if (!intent || !session || !factor || deleteConfirmation !== 'DELETE')
                              throw new Error(
                                'Confirm DELETE and select a supported second factor',
                              );
                            guardDeletion(intent);
                            if (factor.strategy === 'phone_code' && !phonePrepared)
                              throw new Error('Send the enrolled phone code before verifying');
                            const verification = await session.attemptSecondFactorVerification({
                              strategy: factor.strategy,
                              code: secondCode,
                            });
                            setSecondCode('');
                            guardDeletion(intent);
                            if (verification.status !== 'complete')
                              throw new Error(
                                'Second-factor verification is incomplete; account deletion remains blocked',
                              );
                            await finishDeletion(intent);
                          },
                          true,
                        )}
                      </>
                    )}
                    <button
                      onClick={() => {
                        cancelDeletion();
                        setNotice('Account deletion cancelled. No deletion request will be sent.');
                      }}
                    >
                      Cancel account deletion
                    </button>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
      <footer>
        Encrypted financial storage · Standard: server-recoverable key · Private: bring your own key
      </footer>
    </div>
  );
}
function Install() {
  return (
    <section>
      <h2>Connect your portals</h2>
      <p>Install with a userscript manager, then pair each script separately.</p>
      <div className="links">
        <a href="/scripts/portfolio.user.js">Install portfolio script</a>
        <a href="/scripts/bank-subcaps.user.js">Install bank subcaps script</a>
      </div>
    </section>
  );
}
