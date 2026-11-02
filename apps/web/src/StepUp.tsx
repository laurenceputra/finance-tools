import React, { useEffect, useRef, useState } from 'react';
import type { useSession } from '@clerk/clerk-react';

type Session = NonNullable<ReturnType<typeof useSession>['session']>;
type Verification = Awaited<ReturnType<Session['startVerification']>>;
type Factor = NonNullable<Verification['supportedSecondFactors']>[number];

// A refreshed JWT is not reverification. Complete Clerk's first factor and enrolled MFA
// before requesting the sensitive operation; the server independently checks verified fva.
export function StepUp({
  session,
  onVerified,
  onCancel,
}: {
  session: Session | null | undefined;
  onVerified: (assertCurrent: () => void) => Promise<void>;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<'start' | 'email' | 'second'>('start');
  const [code, setCode] = useState(''),
    [factors, setFactors] = useState<Factor[]>([]),
    [factorIndex, setFactorIndex] = useState(0),
    [phoneReady, setPhoneReady] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const actor = useRef(session?.id);
  const intent = useRef(0);
  actor.current = session?.id;
  useEffect(() => {
    intent.current++;
    setStage('start');
    setCode('');
    setFactors([]);
    setPhoneReady(false);
    return () => {
      intent.current++;
    };
  }, [session?.id]);
  async function run(action: (s: Session, check: () => void) => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      if (!session)
        throw new Error(
          'Sign in with Clerk to verify this sensitive change. Your Finance session is unchanged.',
        );
      const id = session.id,
        generation = intent.current,
        check = () => {
          if (actor.current !== id || intent.current !== generation)
            throw new Error('Verification session or intent changed. Start again.');
        };
      await action(session, check);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }
  async function complete(verification: Verification, check: () => void) {
    check();
    setCode('');
    if (verification.status === 'complete') {
      await onVerified(check);
      return;
    }
    if (verification.status !== 'needs_second_factor')
      throw new Error('Verification incomplete. Start again.');
    const supported = (verification.supportedSecondFactors ?? []).filter((f) =>
      ['totp', 'backup_code', 'phone_code'].includes(f.strategy),
    );
    if (!supported.length)
      throw new Error('No supported enrolled MFA factor. This change remains blocked.');
    setFactors(supported);
    setFactorIndex(0);
    setPhoneReady(false);
    setStage('second');
  }
  return (
    <section aria-label="Verify encryption mode change">
      <h2>Verify encryption mode change</h2>
      <p>
        Fresh email verification and enrolled MFA are required. The same data key is retained;
        previous backups or cached keys cannot be erased.
      </p>
      {error && <p role="alert">{error}</p>}
      {stage === 'start' && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async (s, check) => {
              const verification = await s.startVerification({ level: 'multi_factor' });
              check();
              const factor = verification.supportedFirstFactors?.find(
                (f) => f.strategy === 'email_code',
              );
              if (!factor || factor.strategy !== 'email_code')
                throw new Error(
                  'Enable Clerk email reverification before changing encryption mode.',
                );
              await s.prepareFirstFactorVerification({
                strategy: 'email_code',
                emailAddressId: factor.emailAddressId,
              });
              check();
              setStage('email');
            })
          }
        >
          Send mode-change verification code
        </button>
      )}
      {stage !== 'start' && (
        <>
          {stage === 'second' && (
            <>
              <label>
                MFA method
                <select
                  disabled={busy}
                  value={factorIndex}
                  onChange={(event) => {
                    setFactorIndex(Number(event.target.value));
                    setCode('');
                    setPhoneReady(false);
                  }}
                >
                  {factors.map((factor, index) => (
                    <option key={index} value={index}>
                      {factor.strategy}
                    </option>
                  ))}
                </select>
              </label>
              {factors[factorIndex]?.strategy === 'phone_code' && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async (s, check) => {
                      const factor = factors[factorIndex];
                      if (factor.strategy !== 'phone_code') return;
                      await s.prepareSecondFactorVerification({
                        strategy: 'phone_code',
                        phoneNumberId: factor.phoneNumberId,
                      });
                      check();
                      setPhoneReady(true);
                    })
                  }
                >
                  Send MFA phone code
                </button>
              )}
            </>
          )}
          <label>
            {stage === 'email' ? 'Mode-change email code' : 'Mode-change MFA code'}
            <input
              disabled={busy}
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !code}
            onClick={() =>
              void run(async (s, check) => {
                if (stage === 'email')
                  await complete(
                    await s.attemptFirstFactorVerification({ strategy: 'email_code', code }),
                    check,
                  );
                else {
                  const factor = factors[factorIndex];
                  if (!factor || (factor.strategy === 'phone_code' && !phoneReady))
                    throw new Error('Send the enrolled phone code first');
                  await complete(
                    await s.attemptSecondFactorVerification({ strategy: factor.strategy, code }),
                    check,
                  );
                }
              })
            }
          >
            Verify & change encryption mode
          </button>
        </>
      )}
      <button
        onClick={() => {
          intent.current++;
          onCancel();
        }}
      >
        Cancel mode change
      </button>
    </section>
  );
}
