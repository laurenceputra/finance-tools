# Finance Tools

TypeScript pnpm workspace for a React/Vite dashboard, Hono Cloudflare Worker and esbuild userscripts. See application packages for implemented flows; this README is not a claim of production deployment or live-provider verification.

Use Node 22 and `corepack pnpm install --frozen-lockfile`, then `corepack pnpm check`. Individual commands: `test`, `typecheck`, `build`, `dev`, `types:worker`, `deploy:cloudflare`. Workspace imports use `@finance-tools/contracts` and `@finance-tools/crypto` exports (source TypeScript; bundlers resolve them). No global package-manager activation needed.

Root build explicitly runs `@finance-tools/web` before `@finance-tools/userscripts`: Vite clears root `dist`, then esbuild appends `dist/scripts/*.user.js`. Never parallelize these builds. API package `@finance-tools/api` is typechecked by root typecheck and bundled by Wrangler at deployment, never published as an asset. Generate bindings with `corepack pnpm types:worker`; consume generated Env rather than handwritten binding interfaces. Generation emits Env only; the pinned `@cloudflare/workers-types` package supplies runtime declarations, avoiding a large copied runtime definition file.

`corepack pnpm dev` starts local-only Wrangler on 8787 and Vite on 5173; web must proxy `/api` to `http://localhost:8787`. Copy `.dev.vars.example` to ignored `.dev.vars`, provide development Clerk keys and independent random secrets, and apply local migrations with `corepack pnpm exec wrangler d1 migrations apply finance-tools --local`. Local login requires Clerk authorized party/origin configuration matching `http://localhost:5173`. Run `corepack pnpm build` once before dev if Wrangler needs the asset directory.

See [API contract](docs/API.md) and [security boundaries](docs/SECURITY.md).

## Hosting

One Worker serves API plus `dist` static assets at **finance.laurenceputra.com**. Wrangler disables workers.dev and preview URLs. Compatibility date is 2026-10-04. Hourly Cron (`0 * * * *`, UTC) handles retention/deferred deletion. Production needs **Workers Paid**, because streaming export of up to 10,000 objects uses the configured 12,000-subrequest allowance. Free application entitlements are independent from the operator's Cloudflare billing plan.

### One-time operator setup (not performed here)

1. In the owning Cloudflare account enable Workers Paid, create D1 `finance-tools` and R2 bucket `finance-tools` (dashboard or authorized Wrangler provisioning). Replace `REPLACE_WITH_PROVISIONED_D1_ID` in `wrangler.jsonc` with the real D1 UUID. Deployment preflight refuses placeholders before any remote migration runs.
2. Configure a production Clerk instance with domain/origin `https://finance.laurenceputra.com`, the audience `finance-tools`, and required factor-verification claims. Configure lifecycle webhook to `/api/v1/webhooks/clerk` and subscribe to user deletion.
3. Set Worker secrets securely: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ISSUER`, `CLERK_AUDIENCE`, `CLERK_WEBHOOK_SECRET`, `ACCESS_JWT_SECRET`, `SESSION_WRAP_SECRET`; optional `CLERK_JWT_KEY`. Use dashboard/interactive `corepack pnpm exec wrangler secret put NAME`, never command-line secret values. Generate independent random 32-byte base64url JWT/wrapping secrets. If web needs a build-time publishable key, set its documented Vite variable in Builds too; publishable keys are public, secret keys are never Vite variables.
4. Connect this repository to **Cloudflare Workers Builds**, root directory `/` (repository root), production branch `main`. Build command: `corepack pnpm install --frozen-lockfile && corepack pnpm check`. Deploy command: `corepack pnpm deploy:cloudflare`. This runs preflight, **remote D1 migrations first**, then Worker deployment; no manual migration/deploy step is needed on subsequent main pushes. Supply scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to Cloudflare Builds deployment environment. Use backward-compatible migrations: migration success followed by deployment failure must leave the old Worker operational.
5. Disable nonproduction branch builds and preview deployments in the Builds dashboard. Confirm only main auto-deploys, custom domain resolves to this Worker, no workers.dev/preview URLs exist, and Cron is registered. Deployment preflight additionally requires Cloudflare's `WORKERS_CI=1` and `WORKERS_CI_BRANCH=main`; missing/other values are rejected before remote migrations. Do not substitute Pages branch variables or set these flags to bypass the guard for manual deployment. Dashboard branch configuration remains mandatory.

GitHub Actions validates only with frozen pnpm lockfile and read-only contents access; no production credentials or GitHub deployments. Never enable Pages deployment. **No production resources, credentials, Clerk configuration or live deployment have been verified here.** These remain operator prerequisites; passing local checks is not production readiness certification.

### Feature boundaries

- Portfolio/bank-subcap adapters are separate products with scoped userscript access; provider layouts/data must be verified against actual authorized sessions before relying on results. Fixture coverage is not live verification or financial advice.
- Login/session pairing is independent from vault unlock. Recovery requires the separately saved recovery secret; operators cannot decrypt accounts.
- Browser restoration first uses the application's refresh cookie, independently of Clerk's current login state. Opt-in indefinite local key storage does not make an application session indefinite; fresh Clerk authentication is still required for deletion step-up. These behaviors need app-level restoration/logout regression coverage.
- Capture adapters can read only the supported data actually available in the authorized provider page/context. Paginated, unloaded, virtualized or changed layouts may yield partial/unsupported capture; do not describe fixtures or a successful script build as complete live-provider support. A capture timestamp records observation, not necessarily the provider's source-data timestamp.
- Settings persist; history expires after three calendar months. Export is encrypted and recovery-safe only when the corresponding unlock credential is preserved.
- Local indefinite unlock is opt-in and cannot guarantee OS-backed protection. Key rotation/multi-device recovery UI and provider coverage should be checked in the owning app docs rather than inferred from this scaffold.

This foundation is original code. Reused adapter implementations must retain their original MIT copyright/license notices alongside the project MIT license; see adapter-package attribution files for actual sources.
