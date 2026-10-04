import { captureMaybank, captureUob } from '@finance-tools/provider-adapters';
import { runtime } from './runtime';
const app = runtime('bank-subcaps');
app.button('Capture supported visible bank table', async () => { if (!app.client.unlocked) throw new Error('Unlock before capturing'); const now = new Date().toISOString(); const data = location.hostname === 'pib.uob.com.sg' ? await captureUob(document, now) : await captureMaybank(document, now); if (!data.length) throw new Error('No uniquely scoped supported visible card table. Open Lady’s Solitaire / XL Rewards transactions.'); await app.add(data); });
