import { normalizeEndowus, normalizeFsm, normalizeOcbc } from '@finance-tools/provider-adapters';
import { installBridge } from './bridge';
import { runtime } from './runtime';
import { EarlyCaptureQueue, EndowusJoin } from './capture-state';
import type { CaptureEvent } from './capture-state';
const app = runtime('portfolio'),
  early = new EarlyCaptureQueue(),
  endowus = new EndowusJoin();
let route = location.href;
const clear = () => {
  early.clear();
  endowus.clear();
};
app.onLock(clear);
setTimeout(() => early.clear(), 30_000);
setInterval(() => {
  if (route !== location.href) {
    route = location.href;
    clear();
  }
}, 200);
function receive(event: CaptureEvent) {
  const context =
    document.documentElement.getAttribute('data-account-context') ??
    document.documentElement.getAttribute('data-customer-id') ??
    undefined;
  if (event.accountContext !== context) {
    clear();
    return;
  }
  const { path, payload, capturedAt } = event;
  if (route !== location.href) {
    route = location.href;
    clear();
  }
  if (event.route && event.route !== route) return;
  if (!app.client.unlocked) {
    early.push(event);
    return;
  }
  const epoch = app.client.lockEpoch;
  const capture = async () => {
    const add = async (data: Awaited<ReturnType<typeof normalizeFsm>>) => {
      const currentContext =
        document.documentElement.getAttribute('data-account-context') ??
        document.documentElement.getAttribute('data-customer-id') ??
        undefined;
      if (epoch === app.client.lockEpoch && route === location.href && currentContext === context)
        await app.add(data);
    };
    if (path === '/fsmone/rest/holding/client/protected/find-holdings-with-pnl') {
      await add(await normalizeFsm(payload, capturedAt));
      return;
    }
    if (path === '/digital/api/sg/ms-investment-accounts/v1/portfolio-holdings/inquiry') {
      await add(await normalizeOcbc(payload, capturedAt));
      return;
    }
    const joined = endowus.add(event);
    if (joined) {
      app.captureUnavailable('');
      const snapshots = await normalizeEndowus(joined.input, joined.capturedAt);
      for (const snapshot of snapshots) {
        if (joined.incomplete)
          snapshot.provenance.flags.push('ENDOWUS_COMPONENT_SUBSETS_OR_MISSING_GOALS');
        if (!context) snapshot.provenance.flags.push('PROVIDER_ACCOUNT_CONTEXT_UNVERIFIED');
      }
      await add(snapshots);
    } else
      app.captureUnavailable(
        'Endowus capture is incomplete: waiting for three responses from this route/account context with request times within 15 seconds. Goal subsets are allowed and flagged; old generations are discarded.',
      );
  };
  void capture().catch((error) => {
    app.captureUnavailable(
      error instanceof Error && error.message.startsWith('Local capture limit')
        ? error.message
        : 'Capture could not be normalized/retained safely. No existing dirty/history data was discarded.',
    );
  });
}
app.onUnlock(() => {
  for (const event of early.take()) receive(event);
});
const bridge = installBridge(receive);
if (!bridge.available) app.captureUnavailable(bridge.error!);
