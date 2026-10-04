# API v1 implementation contract

Base: `https://finance.laurenceputra.com/api/v1`. JSON requests/responses, except 204 responses and signed Clerk webhook payload. Types and strict request validators live in `@finance-tools/contracts`. Times are UTC ISO-8601 strings. Path IDs use `idSchema`; namespace is `settings|history`. Unknown request fields are rejected. Shared `MAX_REQUEST_BODY_BYTES` is 1,572,864 (1.5 MiB), allowing base64 expansion of up to 1 MiB ciphertext (`MAX_DOCUMENT_BYTES`). The ciphertext schema permits at most 1,398,102 unpadded base64url characters; server also checks decoded byte size and canonical encoding. Never accept account IDs from the client: derive from authenticated session.

All failures: `{error:{code,message,requestId,currentRevision?}}`. Statuses: 400 invalid input, 401 invalid/expired credentials, 403 scope/origin denial, 404 missing resource, 409 revision conflict/reused mutation with different payload, 410 expired pairing/history, 413 too large, 429 rate limited, 500 internal. Do not expose secrets or crypto errors. Responses containing credentials/private data use `Cache-Control: no-store`.

## Authentication and sessions

Own access JWT lasts 900 seconds, with issuer, audience, subject account ID, session ID, scopes, iat, exp, jti. Validate algorithm allowlist/signature/issuer/audience and active session on every authenticated call. Opaque refresh tokens have >=256 bits entropy; store hashes only except short-lived encrypted successor retry state. Rotate atomically on every refresh. Every refresh requires `X-Finance-Refresh-Id`, a UUID generated once per logical refresh and retained with its input credential until completion. Retrying the same predecessor and UUID within 120 seconds returns the same successor credential without rotating again; encrypted retry state uses the independent SESSION_WRAP_SECRET and is removed after grace. Different UUID reuse or replay after grace revokes the entire token family. Clients serialize refreshes and reuse the UUID after network failure, never generate a new UUID for that retry. Idle expiry 90 days; fixed absolute expiry 365 days from session creation. Client kind/scopes are persisted and cannot be escalated during refresh.

Browser refresh token: `__Host-finance-refresh`, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain; never return it in JSON. Browser access token lives in memory. Cookie mutation calls require exact configured Origin (reject missing/null) and `X-Finance-CSRF: 1`; CORS allows only app origin with credentials. Userscript refresh credentials are explicit JSON and stored in GM storage, not cookies. Script uses Bearer access token and no credentials/cookies. No wildcard credentialed CORS. Do not trust client.kind alone to bypass cookie CSRF checks.

| Method/path                | Auth                                    | Body                                  | Success                                                               |
| -------------------------- | --------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| POST `/session/exchange`   | fresh Clerk token in body               | `exchangeRequestSchema`               | 200 `SessionTokens`; browser cookie set, script refreshToken returned |
| POST `/session/refresh`    | refresh cookie or explicit script token | `refreshRequestSchema` (`{}` browser) | 200 `SessionTokens`; rotate refresh                                   |
| POST `/session/logout`     | refresh credential (or own access JWT)  | `refreshRequestSchema`                | 204 revoke current session and clear cookie; idempotent               |
| POST `/session/logout-all` | own access JWT                          | `{}`                                  | 204 revoke all account sessions, clear cookie                         |
| GET `/me`                  | own access JWT                          | none                                  | 200 `MeResponse`                                                      |
| GET `/sessions`            | own access JWT                          | none                                  | 200 `{sessions:SessionInfo[]}`                                        |
| DELETE `/sessions/:id`     | own access JWT                          | none                                  | 204 revoke account-owned session; clear cookie if current             |

Clerk token verification uses configured issuer/JWKS/audience and authorized parties; exchange requires token issued within last 5 minutes. Provision account by Clerk subject. Free entitlements are server-owned defaults, never writable by client.

Own sessions are independent of the continuing Clerk browser login. On browser reload attempt cookie refresh before requiring Clerk sign-in; a valid own refresh cookie can restore access while Clerk reports signed out. Clerk is required for initial exchange and destructive step-up, not each restore/refresh. Local indefinite vault-key persistence is a separate opt-in unlock convenience: it does not extend the 90-day inactivity/365-day absolute session limits. Explicit logout clears own session state; Clerk sign-out alone must not be mistaken for server-side own-session revocation. Regression tests should cover cookie restoration with Clerk absent, restored key/session independence, expired/revoked refresh, and explicit logout.

Products are `portfolio|bank-subcaps`, separate from namespaces. `client.products` is mandatory and persisted with the session. Browser requests both products; each userscript requests only its respective product. `client.name` is a non-authoritative display label, never a permission source. Server checks product scope on every document operation and filters list/export results by persisted product scopes; document IDs/prefixes are not permission boundaries. PUT requires a `product` field, persisted alongside the encrypted document in D1 and returned in `StoredDocument`; updates cannot change an existing document's product. Cursor validity also binds product scopes. `/me` returns the session's products and namespaces.

## Pairing

| Method/path             | Auth                          | Body                                           | Success                                                               |
| ----------------------- | ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| POST `/pairing/create`  | unauthenticated, rate limited | `pairingCreateRequestSchema` (userscript only) | 201 `PairingResponse`                                                 |
| POST `/pairing/inspect` | own browser access JWT        | `pairingInspectRequestSchema` (ID and code)    | 200 `{client}` containing exact stored label/product/namespace scopes |
| POST `/pairing/approve` | own browser access JWT        | `pairingApproveRequestSchema`                  | 204 bind pairing to approving account and exact requested scopes      |
| POST `/pairing/redeem`  | possession of secret          | `pairingRedeemRequestSchema`                   | 200 `SessionTokens` including script refreshToken                     |

Pairings expire after 10 minutes. Cryptographic random ID/256-bit secret/8-digit code; hash secret/code in storage. UI shows client name and scopes before approval. Approve only once; redeem atomically once, only after approval; 409 pending/already approved, 410 expired/consumed. Limit guesses per pairing and IP. Never pair by short code alone. Pairing does not transfer a vault key/passphrase/recovery secret.

## Vault and encrypted documents

| Method/path                        | Auth                             | Body/query                                    | Success                                           |
| ---------------------------------- | -------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| GET `/vault`                       | access JWT                       | none                                          | 200 `VaultResponse`, 404 uninitialized            |
| PUT `/vault`                       | browser access JWT               | `vaultPutRequestSchema`                       | 200 `VaultResponse`; revision 0 means create-only |
| GET `/documents/:namespace`        | access JWT with namespace scope  | `?cursor=<opaque>&limit=1..100` (default 100) | 200 `DocumentListResponse`                        |
| GET `/documents/:namespace/:id`    | namespace scope                  | none                                          | 200 `StoredDocument`                              |
| PUT `/documents/:namespace/:id`    | namespace scope                  | `documentPutRequestSchema`                    | 200 `StoredDocument`                              |
| DELETE `/documents/:namespace/:id` | namespace scope                  | `documentDeleteRequestSchema`                 | 204                                               |
| GET `/export`                      | browser access JWT               | none                                          | 200 `ExportResponse` (encrypted only)             |
| DELETE `/account`                  | browser access JWT + fresh Clerk | `accountDeleteRequestSchema`                  | 204                                               |

CAS: expectedRevision must equal stored revision; absent document has revision 0. Each successful write increments revision; delete preserves revision tombstone so stale create cannot resurrect data. Namespace/account/document/mutationId identify deduplication records; identical replay returns original status/body without mutation (including delete), different replay 409. Tombstones and mutation records persist until account deletion, subject to finite quotas; reject new mutations when receipt/metadata budgets are exhausted rather than silently discarding replay safety. Vault mutationId is scoped to account/vault. Validate vault envelope key versions match vault keyVersion. Key versions are positive bounded integers; ordinary passphrase rewrap cannot increment keyVersion without a document migration. Document AAD must match account, namespace, document ID, schemaVersion and keyVersion; server cannot decrypt or verify tag, but enforces structural bounds and current vault keyVersion.

Default free limits: 10,000 documents, 1 MiB per envelope, 64 MiB aggregate stored bytes, 50,000 mutation receipts and 16 MiB metadata. Server enforces quotas atomically, including retained receipt blobs/tombstones/pending uploads as applicable; product/namespace declarations never bypass account-wide limits.

History PUT requires occurredAt; settings PUT forbids it. Retention is a rolling **three calendar month** UTC cutoff, subtracting months with day clamped to target month's last day; not 90 days. Reject older history writes with 410; exclude expired history from reads/export and physically purge scheduled. Keep settings indefinitely until deletion. List sorts IDs ascending with opaque account/namespace-bound cursor; returns at most limit current nonexpired documents. Export may require streaming as account size grows; no decrypted values ever sent to server.

Account delete token must belong to same Clerk subject and be issued within 5 minutes. Server also verifies signed Clerk `fva` factor ages: first factor age plus elapsed token age must be <=5 minutes. If trusted Clerk user state indicates an enrolled second factor, require that factor fresh too; reject missing/malformed/unverified claims. A recently issued JWT alone is not recent authentication. Immediately revoke sessions and disable account, then idempotently remove D1 records and R2 objects; retries finish cleanup. Deletion must prevent a concurrent write/provision from resurrecting account. Do not delete Clerk identity implicitly.

`/export` returns encrypted backup only, browser-session gated; it does not constitute decrypted recovery. Local plaintext export/recovery disclosure requires an explicit user action and local unlock/reverification UI; do not silently export unlocked data. Hourly Cron performs retention and deferred cleanup. Streaming export may read up to 10,000 R2 objects; production requires Workers Paid and the configured 12,000-subrequest allowance.

## Public/system

| Method/path            | Body                        | Success                                        |
| ---------------------- | --------------------------- | ---------------------------------------------- |
| GET `/config`          | none                        | 200 `ConfigResponse`                           |
| GET `/health`          | none                        | 200 `{ok:true}` (no secrets/binding internals) |
| POST `/webhooks/clerk` | raw signed Clerk/Svix event | 204 after durable/idempotent acceptance        |

Webhook verifies signature against raw bounded body, timestamp tolerance and event ID dedupe; `user.deleted` disables account/revokes sessions and triggers same cleanup, other events are acknowledged without trusting unverified metadata. No Clerk token accepted as an own access JWT.
