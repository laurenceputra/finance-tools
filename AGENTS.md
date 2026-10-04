# Project conventions

- Use Node 22 and Corepack with the packageManager version; keep pnpm-lock.yaml frozen in CI.
- Use pinned Prettier: `corepack pnpm format` and `corepack pnpm format:check`. Exclude generated bindings/lockfiles from manual formatting.
- Preserve strict shared contracts and validate decrypted application data separately.
- Root build must run web before userscripts: Vite clears dist; userscripts append dist/scripts artifacts.
- Generate Worker bindings with `corepack pnpm types:worker`; do not handwrite Env.
- Keep production secrets out of Git/CI logs. GitHub validates only; Cloudflare Builds deploys main only, with previews disabled.
- Run targeted tests and `corepack pnpm check` before review. Do not deploy/provision or commit without explicit authorization.
- Retain original MIT notices for reused adapter code. Describe provider limitations truthfully; fixtures are not live verification.
