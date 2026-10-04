// Browser-test-only alias. Never imported by the production Vite configuration/entry point.
import React, { useSyncExternalStore } from 'react';
let state: { user: string | null; loaded: boolean } = { user: null, loaded: true };
const listeners = new Set<() => void>();
type Factor =
  | { strategy: 'totp' | 'backup_code' }
  | { strategy: 'phone_code'; phoneNumberId: string; safeIdentifier: string };
let factors: Factor[] = [],
  firstVerified = false,
  secondVerified = false,
  pendingSecond: (() => void) | undefined,
  delaySecond = false;
const verificationCalls: string[] = [];
export function configureVerification(
  strategy: 'totp' | 'backup_code' | 'phone_code' | 'none',
  delayed = false,
) {
  factors =
    strategy === 'none'
      ? []
      : strategy === 'phone_code'
        ? [{ strategy, phoneNumberId: 'phone-fixture', safeIdentifier: '***1234' }]
        : [{ strategy }];
  firstVerified = false;
  secondVerified = false;
  delaySecond = delayed;
  pendingSecond = undefined;
  verificationCalls.length = 0;
}
export const verificationState = () => ({
  calls: [...verificationCalls],
  firstVerified,
  secondVerified,
  pending: !!pendingSecond,
});
export const resolveSecond = () => {
  pendingSecond?.();
  pendingSecond = undefined;
};
export function setClerkUser(value: string | null) {
  state = { ...state, user: value };
  for (const listener of listeners) listener();
}
export function setClerkLoaded(loaded: boolean) {
  state = { ...state, loaded };
  for (const listener of listeners) listener();
}
function current() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
export function useAuth() {
  const { user: userId, loaded } = current();
  return {
    isLoaded: loaded,
    isSignedIn: !!userId,
    userId,
    getToken: async () => {
      verificationCalls.push('token');
      return userId
        ? `e30.${btoa(JSON.stringify({ sub: userId, sid: `clerk-${userId}`, fva: [firstVerified ? 0 : -1, secondVerified ? 0 : -1] })).replace(/=/g, '')}.signature`
        : null;
    },
  };
}
export function useSession() {
  const { user: userId } = current();
  return {
    session: userId
      ? {
          id: `clerk-${userId}`,
          startVerification: async ({ level }: { level: string }) => {
            verificationCalls.push(`start:${level}`);
            return {
              status: 'needs_first_factor',
              supportedFirstFactors: [{ strategy: 'email_code', emailAddressId: 'email-fixture' }],
              supportedSecondFactors: factors,
            };
          },
          prepareFirstFactorVerification: async () => {
            verificationCalls.push('prepare:email');
          },
          attemptFirstFactorVerification: async ({ code }: { code: string }) => {
            verificationCalls.push('attempt:email');
            if (code !== 'email-code') throw new Error('Invalid fixture email code');
            firstVerified = true;
            return {
              status: factors.length ? 'needs_second_factor' : 'complete',
              supportedSecondFactors: factors,
            };
          },
          prepareSecondFactorVerification: async ({
            strategy,
            phoneNumberId,
          }: {
            strategy: string;
            phoneNumberId: string;
          }) => {
            if (strategy !== 'phone_code' || phoneNumberId !== 'phone-fixture')
              throw new Error('Invalid fixture phone preparation');
            verificationCalls.push('prepare:phone');
          },
          attemptSecondFactorVerification: async ({
            strategy,
            code,
          }: {
            strategy: string;
            code: string;
          }) => {
            verificationCalls.push(`attempt:${strategy}`);
            if (delaySecond)
              await new Promise<void>((resolve) => {
                pendingSecond = resolve;
              });
            if (code !== 'second-code') throw new Error('Invalid fixture second code');
            secondVerified = true;
            return { status: 'complete', supportedSecondFactors: factors };
          },
        }
      : undefined,
  };
}
export function useClerk() {
  return { signOut: async () => setClerkUser(null) };
}
export function SignIn() {
  return <p>Clerk test fixture — production uses the real Clerk component.</p>;
}
