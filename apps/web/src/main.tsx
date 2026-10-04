import React from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import {
  FinanceClient,
  browserCoordinator,
  browserTransport,
  indexedStorage,
} from '@finance-tools/client';
import type { ConfigResponse } from '@finance-tools/contracts';
import { App } from './App';

const client = new FinanceClient(
  browserTransport(`${location.origin}/api/v1`),
  indexedStorage,
  'browser',
  browserCoordinator,
);
async function boot() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const config = await client.publicRequest<ConfigResponse>('/config');
    if (!config.clerkPublishableKey) throw new Error('Sign-in is not configured');
    root.render(
      <React.StrictMode>
        <ClerkProvider publishableKey={config.clerkPublishableKey}>
          <App client={client} storage={indexedStorage} />
        </ClerkProvider>
      </React.StrictMode>,
    );
  } catch {
    root.render(
      <main>
        <h1>Finance is unavailable</h1>
        <p>
          Configuration could not be loaded. Check your connection and reload. No mock login is
          available.
        </p>
        <button onClick={() => location.reload()}>Retry</button>
      </main>,
    );
  }
}
void boot();
