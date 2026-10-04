# Production setup checklist

## Verified state and remaining blockers

- Cloudflare account: `00000000000000000000000000000000`.
- D1 `finance-tools` **created**, ID `REPLACE_WITH_PROVISIONED_D1_ID`; configured in Wrangler. Remote migrations have **not** been applied: the deployment command intentionally permits Workers Builds on main only.
- R2 listing failed with Cloudflare error **10042** (R2 not enabled). Bucket creation/availability is **not verified**.
- Workers Paid subscription, Git-connected Workers Builds, production Clerk configuration/secrets, custom-domain routing and live application are **not verified**. No production deploy has been performed.
- Initial Git connection needs interactive dashboard authorization. Workers CI write access under the available OAuth authorization is unverified; do not imply Builds has been connected automatically.

## Cloudflare dashboard

1. Select the account above. Open **Workers & Pages → Plans** and verify Workers Paid is active (required by the 12,000-subrequest export allowance). Do not automatically upgrade billing; obtain operator approval if absent.
2. Open **R2 Object Storage → Overview**, enable R2 and complete any billing confirmation, then **Create bucket** named exactly `finance-tools`. Confirm the bucket appears. Do not create another D1 database; the existing ID is already configured.
3. Open **Workers & Pages → Create application → Workers → Import a repository** (or the Git import option shown in your dashboard). Authorize the GitHub connection interactively and select this repository. Name the Worker `finance-tools`.
4. Set production branch **main** and root directory **/** (repository root). Build command: `corepack pnpm install --frozen-lockfile && corepack pnpm check`. Deploy command: `corepack pnpm deploy:cloudflare`.
5. Under the Worker's **Settings → Builds**, disable nonproduction branch builds/preview builds. Keep production deployments automatic on main only. Never add Pages or GitHub deployment workflows. Wrangler also disables workers.dev and preview URLs.
6. Configure Builds deployment credentials with least privilege for Worker deployment, D1 migrations, R2/static asset deployment and the configured custom domain as needed. Account ID must match above. The preflight requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and Cloudflare-provided `WORKERS_CI=1`, `WORKERS_CI_BRANCH=main`. Do not spoof CI variables locally to bypass this guard.
7. Add Worker runtime secrets listed below through **Settings → Variables and Secrets**. Keep runtime secrets out of GitHub validation and client build variables. If dashboard workflow deploys immediately when connecting, supply secrets/resources first or keep the first build blocked until setup is complete.
8. After the first successful main build, confirm migrations applied before deployment, D1/R2 bindings exist, the custom domain `finance.laurenceputra.com` is routed to this Worker, previews/workers.dev remain disabled, and hourly Cron `0 * * * *` is registered. Verify login, pairing, restore, vault unlock, scoped sync, encrypted export and deletion with an authorized test account. Passing local tests alone is not verification of these production flows.

## Clerk dashboard

1. Create/select a **production** Clerk instance; finish its production-domain/DNS setup for this application and configure allowed origin/authorized party `https://finance.laurenceputra.com`.
2. In **Sessions → Customize session token → Claims**, add `"aud": "finance-tools"` to the existing claims object and save. Use the default session token requested by `getToken()`; **do not substitute a JWT template**, remove default claims, or override `iss`, `sub`, `sid`, `azp`, `iat`, `exp` or `fva`. The server requires the default session identity and factor-verification claims. Confirm the SDK/version supports signed `fva` and reverification; fail closed if unavailable.
3. Copy the instance's actual issuer URL to `CLERK_ISSUER` (not the app origin); set `CLERK_AUDIENCE=finance-tools`. Retrieve production publishable/secret keys from **API Keys**. Optional `CLERK_JWT_KEY` is the configured public verification key, not a signing secret.
4. Under **Webhooks → Add endpoint**, use `https://finance.laurenceputra.com/api/v1/webhooks/clerk`, subscribe to both `user.deleted` and `user.updated`, and store the endpoint signing secret as `CLERK_WEBHOOK_SECRET`. Deletion cleanup relies on deleted events; ban/unban state relies on updated events. Verify signed deliveries after deployment.
5. Runtime secrets: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ISSUER`, `CLERK_AUDIENCE`, `CLERK_WEBHOOK_SECRET`, independent random 32-byte base64url `ACCESS_JWT_SECRET` and `SESSION_WRAP_SECRET`; optional `CLERK_JWT_KEY`. Never expose Clerk secret/webhook/server signing keys through `VITE_*`. If the web app requires a build-time publishable key, supply only its documented public variable.

Clerk session tokens establish identity; application refresh sessions and vault unlock are separate. Browser restore must work from a valid application cookie without a current Clerk login. Deletion requires fresh server-verified factor ages, not merely a recently issued token.

## Local and GitHub validation

Use Node 22, `corepack pnpm install --frozen-lockfile`, then `corepack pnpm format:check` and `corepack pnpm check`. GitHub has no deployment credentials and performs validation only. The current real-browser UI test uses a preinstalled Chromium executable from `/ms-playwright` (or `FINANCE_TEST_CHROME`) and explicitly skips when absent, including on ordinary GitHub runners. No browser download is performed by CI; a passing CI run may therefore omit browser UI coverage. If browser tests become mandatory CI checks, first declare the intended browser tooling/version and add an explicit browser-install/setup step rather than invoking an undeclared latest Playwright package.
