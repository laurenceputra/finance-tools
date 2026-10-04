import { Hono } from 'hono';
import { sessions } from './sessions';
import { documents } from './documents';
import { cleanup, lifecycle } from './lifecycle';
import { ApiFailure } from './security';
import type { Bindings } from './security';

export const app = new Hono<Bindings>();
app.use('/api/*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
  const origin = c.req.header('Origin');
  if (origin === c.env.APP_ORIGIN) {
    c.header('Access-Control-Allow-Origin', origin); c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') {
    if (origin !== c.env.APP_ORIGIN) return c.json({ error: { code: 'origin', message: 'Origin denied', requestId: c.get('requestId') } }, 403);
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Finance-CSRF, X-Finance-Refresh-Id');
    c.header('Access-Control-Max-Age', '600'); return c.body(null, 204);
  }
  await next();
});
app.get('/api/v1/config', c => c.json({ clerkPublishableKey: c.env.CLERK_PUBLISHABLE_KEY, apiVersion: 1, historyMonths: 3 }));
app.get('/api/v1/health', c => c.json({ ok: true }));
app.route('/api/v1', sessions); app.route('/api/v1', documents); app.route('/api/v1', lifecycle);
app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'Not found', requestId: c.get('requestId') } }, 404));
app.all('*', async c => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (new URL(c.req.url).pathname.endsWith('.user.js')) {
    if (response.headers.get('Content-Type')?.includes('text/html')) return c.text('Not found', 404);
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'application/javascript; charset=utf-8'); headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
});
app.onError((error, c) => {
  if (error.message.includes('admission_capacity')) return c.json({ error: { code: 'admission_capacity', message: 'Admission capacity reached', requestId: c.get('requestId') } }, 429);
  if (error.message.includes('metadata_quota')) return c.json({ error: { code: 'metadata_quota_exceeded', message: 'Metadata quota exceeded', requestId: c.get('requestId') } }, 413);
  const expected = error instanceof ApiFailure;
  // Never log raw errors: SDK/SQL errors can contain credentials or encrypted
  // payloads. Request IDs suffice to correlate aggregate failure telemetry.
  if (!expected) console.error(JSON.stringify({ event: 'api_failure', requestId: c.get('requestId') }));
  return c.json({ error: { code: expected ? error.code : 'internal', message: expected ? error.message : 'Internal server error', requestId: c.get('requestId') ?? crypto.randomUUID(), ...(expected && error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}) } }, expected ? error.status : 500);
});
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) { await cleanup(env); },
} satisfies ExportedHandler<Env>;
