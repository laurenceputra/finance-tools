# API worker

Hono worker implementing `/api/v1` with D1 as the atomic authorization/CAS
boundary and immutable, encrypted-only envelope rows. Binding types are generated
from the root Wrangler configuration, not handwritten.

## Deployment requirements

1. Install workspace dependencies with `corepack pnpm install --frozen-lockfile`.
2. The deployed Worker and D1 already exist; root `wrangler.jsonc` is a placeholder
   template. Set private Builds variables `CLOUDFLARE_D1_DATABASE_ID` and `APP_HOSTNAME`.
   Main-only preflight generates ignored root `wrangler.deploy.jsonc`, setting the DB UUID,
   custom-domain route and HTTPS `APP_ORIGIN`. Both remote migrations and deployment use
   that same private config, which is cleaned up afterward. Builds applies migrations before deployment;
   see the [production setup checklist](../../docs/SETUP.md) for native Builds token
   permissions, including Account D1 Edit. The initial schema includes required
   immutable encrypted payloads; future production changes need new backward-compatible
   migrations. No R2 binding or
   subscription is required. Earlier disposable local development databases need
   recreation, not an in-place upgrade. No databases have been reset; preserve
   local user data and obtain separate authorization before any destructive step.
3. Set production runtime secrets shown in `.dev.vars.example` through the Worker
   dashboard (or nonsecret vars where appropriate). JWT and wrapping secrets are
   **independent random base64url 32-byte keys**. Never reuse Clerk keys. New
   `VAULT_WRAP_SECRET` is required for Standard recovery; it must not reuse
   `SESSION_WRAP_SECRET`. It has not been provisioned by this source change.
4. Configure Clerk's session JWT audience to `CLERK_AUDIENCE`, set the exact
   `CLERK_ISSUER`, and configure its signed `user.deleted` webhook at
   `/api/v1/webhooks/clerk`. `CLERK_JWT_KEY` optionally supplies a PEM public key
   for networkless verification; otherwise `@clerk/backend` fetches Clerk JWKS
   using `CLERK_SECRET_KEY`. When using a pinned public key, coordinate rotation.
   Both exchange and deletion require `CLERK_SECRET_KEY`: they read trusted
   Backend User eligibility, and deletion additionally checks MFA enrollment,
   even with networkless JWT signature verification.
5. Root Wrangler config schedules hourly retention/account cleanup.
   Every expiry stage mutates at most 1,000 indexed rows.
   Session cleanup selects at most 100 expired sessions and deletes at most 1,000
   family hashes before removing unreferenced sessions. Each invocation advances
   one pending deleted account and one pending revocation account, with durable
   round-robin cursors, and at most 1,000 records/table/account. Physical payload
   deletion is four SQL batches of four unreferenced rows. There is no cross-store inventory
   sweep; each ciphertext exists only in its registered SQL row. Cleanup uses at
   most 26 statements, below the Free 50-statement budget. Monitor backlog and
   tune frequency with approval; large deletions take multiple invocations.
6. Ensure root static-assets routing passes `.user.js` requests to the Worker
   if relying on its JavaScript content-type override; otherwise configure the
   equivalent static asset `_headers`. SPA fallbacks must not serve HTML for
   nonexistent userscript downloads.
7. The backend targets **Workers Free**, with no Paid subrequest override. Export
   uses separate, reauthorized requests, at most 100 documents / 2 MiB envelope
   JSON plus metadata allowance per page, and one bulk payload query after
   metadata selection. Free has 10 ms CPU per HTTP/cron invocation, 50 D1
   statements/invocation, a 500 MB/database limit and 2 MB/row limit. The 1 MiB
   ciphertext envelope expands to about 1.4 MB JSON. Local tests do not measure
   or certify production Free CPU/daily read/write quotas; monitor those limits.

Run:

```sh
corepack pnpm types:worker
corepack pnpm --filter @finance-tools/api typecheck
corepack pnpm --filter @finance-tools/api test
```

Tests bundle and execute the actual Worker inside workerd, with real SQLite/D1
through pinned Miniflare `4.20251004.0`, not a mock database. Clerk tests
use real RSA signatures and public-key verification. The pinned test runtime
uses compatibility date `2025-10-04`; production uses the root Wrangler date.
`tests/api-client.test.ts` uses the actual FinanceClient/browserTransport plus an
anonymous GM-wire transport against workerd, with simulated browser cookie
machinery and real encrypted vault/document round trips, not mocked API responses.
It also includes a cross-account cookie-refresh regression: a pending mutation
encrypted for account A must not be retried when refresh switches the client to
account B. FinanceClient must lock the old key/state and cancel that operation.
The server cannot infer the intended AAD account from ciphertext alone; the
regression verifies the client's principal-change guard before deployment.

## Routes and deliberate contract extensions/restrictions

New verified exchanges initialize only null vaults as Standard; existing legacy
vaults remain Private. `/vault/key` releases the committed Standard key to active
browser or paired scoped script sessions after revision/mode/epoch rechecks.
The purpose/version/account/key-version-bound AES-GCM server wrap is stored
separately, never in public vault JSON, exports or receipts. `/vault/mode` requires
fresh matching Clerk factors, browser authorization and atomic revision CAS;
retries have metadata-only payload-bound receipts. Conversion keeps keyVersion.
Private→Standard sends a transient authenticated client key with explicit trust
consent; Standard→Private clears the active server wrap. Client wrapper continuity
is verified by the supported flow, not guaranteed against malicious self-corruption.
Mode changes cannot retroactively erase old backups/cached keys. Standard portable
exports require a client-side passphrase wrapper. See [security](../../docs/SECURITY.md).

All documented routes are implemented. Errors are structured and responses are
`no-store`. Mutations accept strictly validated, bounded JSON. Reads of removed
documents return 404; a present expired history document returns 410.
The body bound is the shared `MAX_REQUEST_BODY_BYTES` (1.5 MiB), allowing an
exactly 1 MiB decoded ciphertext plus base64url and JSON overhead. An envelope
one decoded byte over the shared `MAX_DOCUMENT_BYTES` is rejected with 413.

- `/session/exchange` is **browser-only**, with exact `APP_ORIGIN` and
  `X-Finance-CSRF: 1`. No Clerk token can directly establish a userscript session.
- Added **POST `/pairing/inspect`** (browser access + CSRF), body
  `{pairingId, code}`. Returns `{pairingId, client, approved}`; the UI must display
  the immutable stored name/scopes before approval. Codes never go in query
  strings. Approval binds the exact stored scopes, never client-supplied new ones.
- **POST `/session/refresh` requires UUID `X-Finance-Refresh-Id`** in addition to
  the contract's unchanged JSON body. Serialize refresh across tabs/GM instances,
  save the request ID before sending, and retain it with the predecessor token
  until success. A same-ID retry within 120 seconds recovers the same successor
  (AES-GCM encrypted under the server wrapping secret, context-bound to the old
  hash). A competing ID returns 409 `refresh_in_progress`, not family revocation.
  If another refresh already advanced the successor, return 409
  `refresh_superseded`. After grace, reuse revokes the session/token family.
  Browser refresh tokens are exclusively HttpOnly cookies; script refresh tokens
  are exclusively explicit JSON. Script requests containing any Cookie header
  are rejected. Cookie credentials never bypass Origin/CSRF through `client.kind`.
- Pairing proof redemption is atomic. The same valid secret can recover the same
  initial credentials for 120 seconds after redeem, only while its session is
  active and the initial refresh token is still current. It never creates a second
  session. After rotation/recovery timeout it returns 410.
- Global admission limits cap **all outstanding pairing records at 1,000** and
  **rate-limit bucket rows at 10,000**, using atomic D1 counter triggers. Capacity
  rejection is 429 `admission_capacity`; concurrent unique IPs cannot exceed the
  cap. Existing rate buckets can still increment/reject at capacity. Rate calls
  prune at most 100 expired buckets, pairing creation prunes at most 1,000 expired
  pairings, and scheduled cleanup remains bounded. Live rate history is never
  evicted to make room. The caps are operator-controlled in `admission_limits`,
  not client-writable. Pairings include approved/redeemed records until their
  expiry, making this a conservative admission limit.
- `/sessions`, session deletion, logout-all and export require browser sessions;
  userscripts cannot administer other clients. `/me` uses persisted scopes, not
  client-provided JWT scope claims. At most 100 active sessions per account.
- Browser exchange requires both `portfolio` and `bank-subcaps` product grants;
  pairing requires exactly one. PUT requires `product`, and each document's product
  is immutable across edits and deletion tombstones. Reads, CAS, replay, delete,
  list and export check persisted grants in addition to namespace scope. List
  accepts optional `?product=portfolio|bank-subcaps`; its cursor binds the effective
  product filter, account and namespace. Old sessions without products fail closed.
- Vault rewrap at the same keyVersion is supported. **Changing an established
  keyVersion returns 409**: a safe whole-vault rekey/re-encryption protocol is
  not part of these contracts, and accepting arbitrary increments would strand
  all existing ciphertext. Envelope versions must match the vault exactly.
- Free quota is 10,000 live documents plus **64 MiB stored envelope JSON across
  current, retained and not-yet-cleaned unreferenced versions**. Old immutable settings versions retained
  for perpetual mutation replay consume quota too. History versions are removed
  at their own three-calendar-month cutoff, even if overwritten/deleted earlier.
  No hidden unlimited version-history allowance. Export is paged encrypted
  JSON; concurrent edits may appear in later pages (not a snapshot).
- An independent **16 MiB logical metadata budget and 50,000 receipt limit**
  cap permanent vault responses, mutation receipts, revision tombstones and blob
  registry rows. Atomic triggers account for UTF-8 vault/receipt response sizes
  plus conservative row/index allowances (512 bytes/document, blob or receipt,
  1,024/session or approved pairing, 768/refresh predecessor). These are logical
  application budgets, not measurements of SQLite file pages or Time Travel.
  Repeated delete/vault writes cannot bypass quotas through lack of a payload write.
  Identical replay remains available at the cap, without allocating a new receipt.
  Expired history receipts retain their charged identity/hash but release response
  bytes when scrubbed; account cleanup releases records in bounded batches.
- List responses have a **2 MiB page budget**, using registered blob byte sizes
  plus response metadata allowance before fetching ciphertext. Even `limit=100`
  can return fewer documents, with a cursor after the last included ID; no large
  documents are skipped. List/export fetch only the selected page in one
  ownership-scoped SQL query and fail closed on missing/corrupt envelopes.
  The 500 MB shared database includes every account, retained versions, metadata
  and indexes; per-account quotas are not reserved physical capacity. Monitor
  database size and deny/limit new usage before physical capacity is exhausted.
- Account deletion immediately leaves a permanent disabled subject tombstone,
  immediately invalidates all sessions through the account's disabled-state check,
  clears the vault and schedules durable cleanup. It does not scan/write every
  session as part of revocation. A retry with
  fresh same-subject Clerk proof + Origin/CSRF works despite revoked own access;
  active accounts additionally require a matching own browser session. The Clerk
  identity is not implicitly deleted. Previously deleted subjects cannot rejoin
  without an explicit future administrative policy.

## Security boundaries and limitations

Clerk verification uses current `@clerk/backend verifyToken` because the Clerk
token arrives in a JSON body (not the request's bearer/cookie). Signature,
audience, authorized party, expiry and issuer are checked. Own access JWTs use
`jose` with HS256 only, fixed issuer `https://finance.example.com`, fixed
audience `finance-tools-api-v1`, 15-minute TTL and per-request active D1 checks.
Refresh idle expiry is 30 days; absolute expiry is fixed at 90 days. Migration
`0002_vault_modes.sql` caps existing sessions from original millisecond timestamps
without extending them. Cookie lifetime cannot exceed the remaining absolute TTL.
Signed Clerk session `sts` must be absent (standard active session JWT) or exactly
`active`; `pending`, null and all unknown explicit statuses are rejected for
exchange and deletion. Both operations read Clerk Backend User `banned` and
`updatedAt` from the trusted service; missing/invalid eligibility data fails
closed. A cached signed token cannot exchange while Clerk reports its user banned,
even before the webhook arrives.

Verified `user.updated` events with boolean `data.banned` and millisecond integer
`timestamp` update reversible `disabled_at`, separately from irreversible
`deleted_at`. State timestamps are monotonic; stale events cannot reverse newer
state, and bans win equal timestamps. Trusted User observations use `updatedAt`
on the same state clock. A ban increments an account epoch, invalidating all
old Finance sessions and approved pairings immediately without an unbounded
session update. Authorization, refresh, session insertion, pairing approval/
redemption, each export page and CAS commits check disabled state and epoch.
Unban re-enables login but never restores old sessions/pairings; account deletion
cannot be undone by either event. Cleanup marks at most 1,000 old-epoch sessions
per account for one pending account per invocation, then drains their
refresh records through the existing bounded expiry path. Ban does not purge the
vault/documents or create a deletion tombstone.

**Fresh token alone is not fresh authentication.** Exchange requires signed
Clerk `iat` within five minutes, but deletion additionally requires a valid signed
`fva: [firstFactorMinutes, secondFactorMinutes]` claim. Missing/malformed claims,
negative first-factor ages and stale verification fail with 403
`reverification_required`. The conservative upper bound is
`factorAge + 1 minute + timeSinceTokenIat <= 5 minutes`, accounting for integer
minute quantization and cached token age. Clerk Backend User `twoFactorEnabled`
is fetched server-side on deletion: when true, **both** factors must satisfy that
bound; `fva[1] === -1` never downgrades an MFA-enrolled user. Stale/unverified MFA
returns 403 `mfa_reverification_required`. Clerk/API failures fail closed. The
same policy applies to deletion retries. Fresh email reverification can satisfy
first-factor verification for users without MFA; enrolled users must also
complete MFA and fetch a new session token. UI must use Clerk's appropriate
reverification flow, not merely force a session JWT refresh.

Product permission is a server-owned, immutable classification, not a document
prefix or client name. A paired script can access its granted product within its
granted namespaces, but cannot relabel an existing other-product ID. This does
not isolate different banks/providers within `bank-subcaps`. The vault wrap/key
is shared across products; no key material is transferred by pairing. The shared
AAD tuple does not include product; product classification is enforced by D1.

The current envelope has no explicit AAD field. The server checks canonical
base64url, nonce/ciphertext bounds, schema and current keyVersion, derives tenant
and document context from auth/path and never accepts client account IDs. The
document write path does not decrypt or verify authentication tags or financial
content, even though Standard mode allows the service to recover the data key.

No bodies, bearer/refresh/pairing credentials, codes, financial plaintext, raw
SDK errors or full URLs are logged by application code. Configure platform logs
and external proxies not to capture request bodies/headers. Svix signatures are
checked against bounded raw bodies with the library's timestamp tolerance;
acceptance/revocation is transactional and lifecycle operations are idempotent.
Webhook IDs expire after one year (Svix's short timestamp window prevents old
signed requests from becoming valid again).

D1 stores an encrypted envelope once per immutable version. One command-trigger
operation checks active account/session, persisted scopes, key version, revision,
retention and quotas, inserts the payload, updates the document pointer and records
the mutation receipt. Any failure rolls back all effects; concurrent identical
replay returns the original receipt/envelope without inserting another payload.
There are no upload reservations or pending/deleting payload states. Random keys
never get reused and payload rows cannot be updated. Bounded SQL deletion directly
and atomically checks both document and receipt references, retaining original
settings ciphertext for perpetual mutation replay. Retention tombstones and
payload hashes remain but expired history
receipts have ciphertext pointers/responses scrubbed, returning 410 on replay.
