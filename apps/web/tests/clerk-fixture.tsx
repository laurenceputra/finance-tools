// Browser-test-only alias. Never imported by the production Vite configuration/entry point.
import React, { useSyncExternalStore } from 'react';
let state: { user: string | null; loaded: boolean } = { user: null, loaded: true };
const listeners = new Set<() => void>();
export function setClerkUser(value: string | null) { state = { ...state, user: value }; for (const listener of listeners) listener(); }
export function setClerkLoaded(loaded: boolean) { state = { ...state, loaded }; for (const listener of listeners) listener(); }
function current() { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => state); }
export function useAuth() { const { user: userId, loaded } = current(); return { isLoaded: loaded, isSignedIn: !!userId, userId, getToken: async () => userId ? `e30.${btoa(JSON.stringify({ sub: userId, sid: `clerk-${userId}` })).replace(/=/g, '')}.signature` : null }; }
export function useSession() { const { user: userId } = current(); return { session: userId ? { id: `clerk-${userId}` } : undefined }; }
export function useClerk() { return { signOut: async () => setClerkUser(null) }; }
export function SignIn() { return <p>Clerk test fixture — production uses the real Clerk component.</p>; }
