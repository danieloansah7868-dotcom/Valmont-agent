# Security and threat model

This document describes the MVP's boundaries and the additional controls required before production use.

## Assets

- GitHub OAuth tokens, repository authorization, and repository visibility
- model provider credentials
- private source code and documentation
- workspace files and command output
- approval records and audit history
- user/session identity
- optional customer account credentials, sessions, and order history
- locally persisted Chat with Valmont conversation history

Valmont must not read or transmit `.env` files, credentials, private keys, payment data, or customer-record exports. Raw source and retrieved repository context are not stored in the application database or chat store. Reopenable chat messages are intentionally persisted after redaction in the ignored local chat store — a SQLite database (`chat-store.sqlite`), with the older JSON file retained only for one-way migration — and must be treated as sensitive user data.

## Trust boundaries

1. **Browser ↔ Next.js:** browser input is untrusted. Mutations require same origin, a double-submit CSRF token, Zod validation, and rate checks.
2. **Customer account ↔ Next.js:** customer passwords are scrypt-hashed, session cookies are opaque HttpOnly/SameSite values, and the database stores only session/token hashes. Verification and reset tokens are one-time and expire; guest-order linking is deferred until the email is verified. Customer accounts are an explicit per-website opt-in (`features.customerAccounts`, default off): websites without it expose no account link, never attach a session at checkout, refuse order claims, and hide claimed orders from `/account`. Backups carry customer accounts as hashes only (scrypt envelopes, SHA-256 token digests — never plaintext); a restore inserts with or-ignore semantics and never overwrites an existing account's password hash. Email delivery uses Resend only when `RESEND_API_KEY` + `NOTIFY_EMAIL_FROM` are both present and valid; partial/malformed/injection values fail closed with typed 503.
3. **Next.js ↔ GitHub/model:** credentials are server-only. OAuth session payloads are AES-256-GCM encrypted and placed in short-lived HttpOnly cookies. Production should store token ciphertext in PostgreSQL/KMS-backed storage and keep only an opaque hashed session ID in the cookie.
4. **Repository creation ↔ GitHub:** creation is an explicit authenticated form mutation, not a model capability. The server fixes the GitHub host, endpoint, authenticated owner, and README initialization; the user controls only validated metadata and private/public visibility.
5. **Repository ↔ retrieval/model:** repository content is adversarial, including prompt injection. Path exclusion, content bounds, lexical selection, redaction, structured output, tool validation, and capability gates apply independently of model instructions. Chat marks repository excerpts as untrusted and exposes no write tools.
6. **Chat ↔ coding workflow:** a chat has no workspace or GitHub mutation capability. Its only handoff is an editable task-form draft; task creation and both approval gates remain separate server-side operations.
7. **Agent ↔ workspace:** generated paths and commands are adversarial. Only explicit provider methods are exposed. There is no arbitrary shell tool.
8. **Workspace ↔ host/network:** the included local adapter is not a secure isolation boundary. Production must replace it.
9. **Database migrations ↔ operator:** migrations are a controlled operator action (`npm run db:migrate` / `db:verify`), never automatic. The full Drizzle journal `meta/_journal.json` is validated (structure, ordering, SHA-256, existence) and ledger membership is checked by hash+timestamp. Timestamp ordering is never used; journal idx is authoritative (regression: `0007` when earlier than `0006` but idx later).

## Threats and MVP controls

| Threat                                  | Controls                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential leakage to browser/model/log | server-only env variables; sensitive path exclusion; redaction; no raw repository context in persistence; local chat-history access controls; Resend API key and provider bodies never echoed (typed 502) |
| OAuth CSRF/session tampering            | random OAuth state; AES-GCM authenticated encryption; HttpOnly, SameSite, Secure-in-production cookies; expiry                                                                                            |
| Customer credential/session compromise  | scrypt password hashing; opaque random session cookies; SHA-256 token/session storage; expiry, sign-out revocation, and reset revocation                                                                  |
| Customer order takeover                 | customer id filter on history; checkout email match; one-time access-code claim; claim deferred until the account email is verified                                                                       |
| Cross-site mutation                     | same-origin check; double-submit CSRF token; JSON APIs                                                                                                                                                    |
| Unauthorized repository creation        | authenticated session; fixed GitHub endpoint/owner; Zod validation; creation-specific rate limit; no model tool or deletion/settings method                                                               |
| Accidental public repository            | private client/server default; explicit private/public selection; visibility echoed after creation                                                                                                        |
| Path traversal/symlink escape           | absolute-path and NUL rejection; resolved-root prefix check; `realpath` verification; symlink component rejection; workspace roots under generated base                                                   |
| Arbitrary command execution             | exact command-to-argv map; `shell: false`; no command interpolation; timeout; process-group kill; output cap; deployment/migration denylist                                                               |
| Malicious repository script             | npm lifecycle hooks disabled where possible; **not fully mitigated locally**—requires container sandbox and egress policy                                                                                 |
| Prompt injection                        | retrieved content is data, not authority; state machine and tools enforce approvals/capabilities outside prompts                                                                                          |
| Sensitive repository content            | explicit `.env`, key, credential, customer/payment, binary, generated, VCS, dependency exclusions; byte/size checks                                                                                       |
| Unauthorized PR                         | state must be `awaiting_final_approval`; latest final approval must be approved; only `valmont/*`; force false                                                                                            |
| Auto-merge/deploy                       | capabilities absent from provider interfaces; no merge/deploy methods; validations deny migrations/deployments                                                                                            |
| Audit manipulation                      | append-style events with actor/timestamp/metadata; production should add DB constraints and external append-only export                                                                                   |
| Abuse/DoS                               | request and file/output limits; in-process rate limiting; production requires distributed limiter and quotas; email delivery has 10s timeout with timer cleanup                                           |
| SSRF                                    | provider base URL is server configuration, not user input; GitHub host is fixed; Resend host fixed; production should allowlist provider hosts and sandbox egress                                         |
| Migration tampering                     | full journal validation, SHA-256 per file, exact ledger membership, advisory lock, fail-closed on altered/unexpected/duplicate, no timestamp ordering                                                     |
| Email header injection                  | CR/LF rejected in `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM`, angle-bracket injection rejected, sender validated as plain email or display-name format                                                      |

## Approval semantics

Repository creation is separate from model-driven coding: submitting the repository form is the direct user authorization for that immediate GitHub operation. It does not authorize later file changes, and it does not bypass task approvals.

- **Plan approval** authorizes only the plan's workspace edits and allowlisted validation commands.
- **Final approval** separately authorizes branch, commit, and pull-request creation.
- A rejection cancels the task. Reopening requires a new/revised task.
- Approvals are checked in domain code, not only hidden/disabled UI.
- Pull requests remain open for human review. Valmont does not merge or deploy.

## Local chat data

`SqliteChatStore` writes redacted conversation turns, FTS retrieval data, and memories to local SQLite storage with owner-only file mode where the platform supports it. `.data/` is ignored by Git. For upgrades, `CHAT_STORE_PATH` is treated only as a legacy JSON input and is copied to an adjacent `.pre-sqlite-backup` before transactional migration into the distinct `CHAT_SQLITE_PATH` destination (or its derived sibling `.sqlite` path); the JSON source is never opened as SQLite or overwritten. Secret redaction is defense in depth, not a guarantee that arbitrary confidential prose can be recognized, so users must not paste credentials or regulated/customer data. Operators should restrict host access and define backup, retention, and secure deletion practices. Repository excerpts used to answer a turn are not written into chat history.

## Local workspace warning

Path checks and command restrictions protect against common accidental escapes. They cannot contain a malicious compiler, package manager, test script, child process, kernel exploit, or network exfiltration because execution still occurs on the host.

A production `WorkspaceProvider` must use:

- one short-lived, unprivileged container/microVM per task;
- no host filesystem/socket mounts and a read-only base image;
- explicit CPU, memory, PID, disk, time, and output quotas;
- default-deny network with narrowly proxied dependency access when approved;
- no cloud metadata access;
- injected short-lived repository credentials only for the exact operation;
- automatic TTL cleanup and cryptographic workspace IDs;
- image provenance, patching, telemetry, and incident-response procedures.

## PostgreSQL and token storage

The schema contains `encrypted_access_token`, never raw token. Production should use envelope encryption (KMS/HSM), per-record nonces, key IDs/versioning, rotation, access logging, and a separate application role. Session cookies should contain only a random identifier; store its hash with expiry and revoke on sign-out.

Use TLS, backups, point-in-time recovery, row ownership checks, and migration review. Valmont never runs production database migrations automatically — they are a controlled `db:migrate` + `db:verify` operator step with full journal verification, advisory locking, and fail-closed on altered/unexpected/duplicate ledger entries.

## Session secret policy

`SESSION_SECRET` protects the OAuth session cookie, the customer sign-in
cookie, the CSRF token and the encrypted payment settings. It is therefore
validated, not merely required (`src/lib/session-secret.ts`):

- at least 32 characters;
- not a known placeholder (`replace-with-a-long-random-value`, `changeme`,
  `secret`, `password`, …) and not a trivially repeated character;
- the check runs wherever the key is derived (`sessionKey()` throws
  `WeakSessionSecretError`, a typed 503) and in `config.ts`, so `/api/health`
  lists a weak secret under `missingConfiguration` and GitHub sign-in refuses
  to start rather than issuing forgeable cookies.

`.env.example` deliberately ships `SESSION_SECRET=` empty. Generate a value with
`openssl rand -base64 48`.

## Operational checklist

- [ ] GitHub App with minimum selected-repository permissions
- [ ] external sandbox implementation and egress policy (`VALMONT_WORKSPACE_PROVIDER=docker` with the sandbox image, or an equivalent per-task isolation)
- [ ] managed PostgreSQL and migrations applied via controlled `db:migrate` + `db:verify` (never automatic)
- [ ] KMS-backed token encryption and a `SESSION_SECRET` that passes the policy above
- [ ] `APP_URL` set to the public origin (emailed links and the payment return URL are built from it, never from the listening socket) and `TRUST_PROXY=true` only behind a header-rewriting proxy
- [ ] distributed CSRF-aware sessions and rate limiting
- [ ] secret scanning in CI and log sink redaction (Resend keys/bodies never leak)
- [ ] CSP reviewed for deployed provider/observability endpoints. The production policy allows no `unsafe-eval`, no plugins (`object-src 'none'`), no framed content (`frame-src 'none'`) and posts forms only to itself and GitHub. `script-src` still carries `'unsafe-inline'` because the App Router streams its RSC payload as inline scripts and `next.config.ts` `headers()` cannot mint a per-request nonce; moving that header into `src/proxy.ts` with a nonce is the open follow-up.
- [ ] immutable audit export and alerts for failed gates and `migrations.status: incomplete` health
- [ ] dependency/image scanning and regular rotation
- [ ] penetration test focused on repo prompt injection and sandbox escape
- [ ] Resend `RESEND_API_KEY` + `NOTIFY_EMAIL_FROM` validated together, anti-enumeration config check before lookup

## Website Studio Phase 1 Security

### Studio route controls

Controls differ by method, so they are listed by what each actually applies.
Authentication and owner scoping are the only two that are on every route.

| Control          | Implementation                                                                                                                                                                                                                                                                                                                                                             | Applies to                                            | Failure |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------- |
| Authentication   | `requireApiSessionUser()`                                                                                                                                                                                                                                                                                                                                                  | every Studio and backup route, reads included         | 401     |
| Owner scoping    | `owner_id` in the SQL itself                                                                                                                                                                                                                                                                                                                                               | every read, update and delete                         | 404     |
| CSRF             | `assertCsrf` — `x-valmont-csrf` must match the `valmont_csrf` cookie                                                                                                                                                                                                                                                                                                       | mutations only (`POST`, `PATCH`, `DELETE`, import)    | 403     |
| Origin           | `assertSameOrigin` (called by `assertCsrf`)                                                                                                                                                                                                                                                                                                                                | mutations only                                        | 403     |
| Rate limiting    | Authenticated Studio/backup routes key the bucket by canonical owner id + action (`studio-mutation`, `backup-export`, `backup-import`). Client `x-forwarded-for` / `x-real-ip` values are ignored for those routes. Unrelated chat/task/OAuth routes still use the existing request-key helper. Limits: 30/min draft mutations, 10/min backup export, 5/min backup import. | mutations and both backup routes; **not** draft reads | 429     |
| Body size        | `readBoundedJson` — 1 MB drafts, 25 MB backup import                                                                                                                                                                                                                                                                                                                       | requests with a body                                  | 413     |
| Input validation | `siteBriefSchemaV1` / `parseBackup`                                                                                                                                                                                                                                                                                                                                        | requests with a body                                  | 400     |

`GET /api/studio/drafts` and `GET /api/studio/drafts/[id]` carry authentication
and owner scoping only. They take no body and change nothing, so CSRF and body
limits do not apply; they are also **not** rate limited, which is a gap worth
closing if these endpoints are ever exposed beyond a signed-in session.

### Internal error detail — strict typed ApiError

`safeApiError` is **strict**: it trusts only explicit `ApiError` subclass instances defined in `src/lib/api-errors.ts`. All other errors — arbitrary `Error("Task not found")`, plain objects with `status`, Zod errors, JSON syntax errors, driver/network errors — are mapped to generic responses without leaking internal detail:

- `ApiError` instance → its intentional status (400/401/403/404/409/413/429/502/503) and safe message, screened for internal patterns (`select * from`, `insert into`, `params:`, `ECONNREFUSED`, connection strings, stack frames). If it leaks, it becomes opaque 500.
- `ZodError` → generic 400 `Invalid request`.
- `SyntaxError` / message containing `not valid json` → generic 400 `Invalid request` (bounded JSON never echoes body).
- Everything else → opaque 500 `Something went wrong handling that request. Please try again.`

This removes the old message-text heuristics (`Task not found` → 404, `CSRF` → 403, `Rate limit` → 429, arbitrary `status` property). Intentional statuses are now typed: `BadRequestError` 400, `UnauthorizedError`/`NotConnectedError`/`CustomerNotConnectedError` 401, `ForbiddenError` 403, `NotFoundError`/`ChatNotFoundError`/`TaskNotFoundError`/etc 404, `ConflictError`/`DraftConflictError`/`ImportInProgressError`/`ImportLostLeaseError` 409, `PayloadTooLargeError` 413, `RateLimitError` 429, `CustomerEmailDeliveryError`/`EmailDeliveryError`/`GitHubApiError` 502, `CustomerEmailConfigurationError`/`ConfigurationError` 503.

Tests in `src/lib/api.test.ts` assert that arbitrary message-bearing errors, plain objects with status, driver errors, and network errors remain opaque 500, while typed `ApiError` instances preserve their intentional statuses. Tests never use `vi.resetModules` with partial mocks of `security`/`api` modules, preserving a single shared `ApiError` class identity.

Because the fallback is opaque, every intentional non-500 raised from a store or workflow must be a typed subclass. The remaining plain `Error` + `.status` sites were converted: `OrderTransitionError` (409, illegal order-status transition), `OnlinePaymentUnavailableError` (409, Live selected but incomplete), `ConflictError` for workflow stage/approval conflicts, `TaskNotFoundError` in the workflow, `ForbiddenError` for a task owned by someone else, and `ChatNotFoundError` in the chat store. Route tests assert the status the client actually receives.

### Request bodies

Every JSON route reads its body through `readBoundedJson` (`src/lib/bounded-json.ts`), which counts real bytes while streaming and answers 413 before parsing; the Valmont Pay webhook reads its raw body through `readBoundedText` (50 KB) so the HMAC is computed over exactly the bytes that were bounded. No route calls `request.json()` directly.

### Owner isolation

Every read, update, and delete is scoped by `owner_id` in the SQL statement
itself, not filtered afterwards. A draft belonging to somebody else and a draft
that does not exist produce the **same generic 404 with the same body**, so the
API cannot be used to discover which ids are real. Unit tests assert this
directly against the route handlers; an end-to-end test also compares the two
responses byte for byte, but see "Test status" below for what has actually run. Owner identity comes from the
encrypted session and is mapped through `deterministicUuid("github:" + id)`; it
is never taken from the request body.

### Concurrency safety

Draft updates are a single conditional `UPDATE ... WHERE id AND owner_id AND
revision ... RETURNING`. Zero returned rows is always an error (409 or 404),
never a success. Two writers on the same revision cannot both win, and no
writer's changes are discarded without the owner being told.

### Untrusted input

- **URLs** — `isHttpsSafeUrl` accepts `https` only and rejects embedded
  credentials, `localhost`, and literal addresses in every private, loopback,
  link-local, CGNAT, multicast or reserved range: `0.0.0.0/8`, `10/8`,
  `100.64/10`, `127/8`, `169.254/16` (including the cloud metadata address),
  `172.16/12`, `192.168/16`, `224/4`+, IPv6 `::`, `::1`, `fc00::/7`,
  `fe80::/10`, `ff00::/8` and `2001:db8::/32`. Because several IPv6 forms carry
  an IPv4 address inside them, the embedded address is extracted and tested too
  — IPv4-mapped (`::ffff:169.254.169.254`), IPv4-compatible (`::7f00:1`), SIIT
  (`::ffff:0:7f00:1`), NAT64 (`64:ff9b::7f00:1`, `64:ff9b:1::/48`), 6to4
  (`2002:7f00:1::`) and Teredo (`2001:0::/32`, both the unobfuscated server
  address and the XOR-obfuscated client address). A public address in any of
  those encodings is still allowed; it is the destination that is judged, not
  the notation.

  NAT64 is handled per RFC 6052 rather than by reading the last two words.
  The address does not sit in a fixed place: under the local-use `64:ff9b:1::/48`
  prefix it occupies bits 48-63 and 72-95, straddling the reserved suffix byte.
  An earlier version of this check read only the tail, which allowed
  `64:ff9b:1:7f00:1:0:808:808` — a loopback in the payload slots with a public
  address parked in the tail — and wrongly refused `64:ff9b:1:808:808::`,
  whose public payload has a zero tail. Both cases are now covered by tests. This blocks
  `javascript:`, `data:`, and SSRF-shaped values. **Phase 1 never fetches a URL
  a user typed** — these values are only rendered as links, with
  `rel="noopener noreferrer nofollow"`, after passing the same check the schema
  applies.

  **This is a link-safety check, not a complete SSRF defence**, and the
  difference matters the day something does fetch one of these. It judges the
  literal string only. It performs no DNS resolution, so a public hostname that
  _resolves_ to a private address is not detected; it does not follow
  redirects, so a permitted URL that redirects to `169.254.169.254` is not
  detected; and it does no punycode or homoglyph analysis. Any future
  server-side fetch must re-validate the resolved IP at connect time and on
  every redirect hop, through this same reserved-range list.

- **Text** — the preview renders text as text. There is no
  `dangerouslySetInnerHTML` anywhere in the Studio, so `<img src=x onerror=...>`
  is displayed literally, never executed. A browser test asserts this (CI
  reports it green; the log has not been read — see "Test status").
- **Colours** — strict `#RRGGBB`. **Phones** — E.164 `/^\+\d{8,15}$/`.
- **Assets** — `assetStatus` is `z.literal("not_provided")`: a marker, not a
  URL. There is no upload control and no arbitrary asset URL can be stored.

### Error and log hygiene

- `safeApiError` strict typed errors as described above; no message heuristics.
- Backup-import failures go through `parseBackup`, which reduces Zod issues to at most five field **paths** and never echoes submitted values.
- `readBoundedJson` returns generic `Invalid request` on JSON syntax errors, never echoing body (covered by `src/lib/bounded-json.test.ts`).
- Customer email: `sendCustomerEmail` normalizes all provider failures to generic 502 `CustomerEmailDeliveryError` without leaking provider bodies, keys, or status texts; config failures are typed 503 `CustomerEmailConfigurationError`. Both covered by `src/lib/customer-email.test.ts` including injection cases and timeout cleanup.
- Resend config: `src/lib/resend-config.ts` validates `RESEND_API_KEY` + `NOTIFY_EMAIL_FROM` together, rejects blank/partial/malformed/CR-LF/angle-bracket injection, accepts plain and display-name senders. Covered by `src/lib/resend-config.test.ts`.

### Backup imports

An imported file is fully untrusted input. Its version is checked before
anything is written; unknown versions are rejected outright. `ownerId` fields
inside the file are ignored and every record is reassigned to the authenticated
account, so a crafted backup cannot plant records under another user or read
theirs. Draft ids must be UUIDs, so a hand-edited file cannot push an
illegal identifier as far as the database driver. A colliding draft id becomes a
new copy instead of overwriting existing work.

**Atomicity depends on the storage backend, and the API reports which applies:**

| Backend                     | `atomicity`          | Guarantee                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite (default)            | `single-transaction` | Chat, memories and drafts share one connection and one transaction. Any failure rolls all three back. The export reads chat and drafts inside one read transaction, so a backup file is a consistent snapshot.                                                                                                             |
| PostgreSQL (`DATABASE_URL`) | `coordinated`        | Chat is still SQLite, studio is PostgreSQL. **There is no distributed transaction** and a mixed export is **not** one atomic snapshot. A durable coordinator records the staged payload and a snapshot of both stores, holds an owner-level **lease** (token + generation + heartbeat expiry), then checkpoints each half. |

On the coordinated path every failure — including a process killed between the
two commits, a container eviction, or a dropped connection — rolls both stores
back to their exact previous state. The rollback runs immediately when the
process survives, and otherwise automatically at the start of the next import
attempt, because the job record on disk is enough to restore from after a
restart. Success is reported only after both halves committed; a rolled-back
import is reported as a plain failure, never a partial success.
`PartialImportError` is reserved for the exceptional case where the rollback
itself cannot complete (for example PostgreSQL is unreachable at that moment);
the response names the halves known to have committed, and the recovery snapshot
stays on disk (with the owner lease held) so the next attempt finishes the
rollback before importing anything new. A second import for the same owner
inspects the lease and returns `409` while it is still active; it never
restores a live job. Recovery may claim a job only after the lease expires,
and only by an atomic compare-and-swap on the lock token and generation. An
old process holding an obsolete token cannot write, sanitize or release the
replacement lock. Lease generations come from a durable per-owner counter and
never repeat, and an expired lease can never be renewed or resurrected by its
old holder. PostgreSQL Studio writes are additionally fenced inside
PostgreSQL itself: a durable per-owner `studio_import_fences` row (identity
only — owner id, job id, random token, monotonic generation; never payload,
snapshot or credentials, and never part of a backup export) must be
conditionally touched as the final statement of every Studio import/restore
transaction, and recovery advances it inside the same transaction that
restores the pre-import snapshot. An obsolete PostgreSQL transaction
therefore either fails that final fence check and rolls back, or commits
strictly before the replacement fence exists and is then fully undone by the
recovery restore that serialized after it — in every ordering both stores end
exactly at the recorded pre-import state. After a successful import or a successful rollback the
journal payload and snapshot are logically deleted; only non-sensitive
metadata remains. That is not guaranteed physical erasure from SQLite pages or
leftover filesystem copies. Coordinator journal rows are never included in a
user backup export. SQLite-only complete imports take the same owner lease so
a second import is also `409` before either store changes.

### No payments, no payment data

Phase 1 executes no payment of any kind. `plannedPaymentMethods` is a small
enum of future-planning preferences, stored alongside `PAYMENT_PLANNING_NOTICE`
which states plainly that nothing is connected. No field in the schema asks for
a card number, a mobile-money PIN or a merchant credential.

Free text is a different matter, because a person can paste anything into a
description or a note. Every free-text field in the Site Brief — including the
list fields and product names — is passed through `redactSecrets` and
`redactPaymentData` (`src/lib/redact.ts`) during Zod parsing, so a pasted card
number is replaced with `[REDACTED_CARD_NUMBER]` before the value is stored.

**This is a safety net, not a guarantee, and its limits are specific:**

- Card numbers are detected only when a 13–19 digit run also passes the Luhn
  check. A mistyped or deliberately obfuscated number will not match.
- PINs, CVVs and CVCs are redacted only when the digits are adjacent to a label
  such as `PIN` or `CVV`. A bare `1234` is indistinguishable from an order
  number and is deliberately left alone.
- API keys and passwords are matched by known prefixes and `key=value` shapes.
  A novel credential format will pass through.
- Redaction happens at the schema boundary. Anything written through a path
  that bypasses `siteBriefSchemaV1` is not covered.
- **It covers free-text fields only.** `businessName`, `adminEmail` and
  `domainName` are validated for shape but not redacted, so a Luhn-valid digit
  run typed into a business name is stored as written. Raised by independent
  review. These fields are constrained and short, redacting a name field risks
  mangling legitimate input, and the honest position is that the rule "never
  store card numbers" is enforced by not asking for them — not by filtering.

Nobody should be encouraged to paste payment details on the strength of this.
The correct control remains not collecting them, and Phase 1 asks for none.

### Custom domains — ownership proof, not just a CNAME

A hostname is served for a website only after **two** DNS records resolve
(`src/lib/studio/domain-verification.ts`):

- `TXT _valmont-verify.<hostname>` = `valmont-verify=<token>` — the token is
  issued per website (`newVerificationToken()`, 16 random bytes as hex) and only ever
  shown to the website's owner. It proves control of the zone, which a CNAME
  alone does not: a dangling CNAME left behind after a previous tenant
  released the hostname would otherwise let anyone claim it.
- `CNAME <hostname>` → `STUDIO_PLATFORM_HOST`, compared exactly. There is no
  A-record / IP fallback, so a hostname that merely resolves to the same
  address as the platform is not accepted.

Hostnames are normalised and validated against the DNS label grammar before
any lookup (400 otherwise) and are unique across tenants (409 when another
website already holds one). Active domains are re-checked by the proxy in the
background, at most every 24 hours, and drop back to `pending` when either
record disappears. Backups never carry the token: a restored domain is
re-issued a token and starts `pending`, so a file copied to another machine
cannot serve a hostname it has not proved.

### Test vs live orders

Every order carries `payment_mode` (`test` | `live`), stamped by the checkout
route from the payment configuration in force at that moment — never from the
client. Test orders are badged in every merchant view and excluded from
revenue analytics, so a simulator payment can never be presented as money
received. When Live is selected but the connection is incomplete, online
methods are refused with 409 **before** an order row exists; the fail-closed
webhook therefore never has an orphaned pending order to ignore.

### Unauthenticated order pages — no personal data

`/orders/[id]/confirmed` is reachable with no session: it looks the order up by
id alone, so anything printed there is public to whoever holds the link. It
therefore prints no phone number at all, with one deliberate exception — the
recipient of a data-bundle order, masked by `maskGhanaMobile` as
`024 ••• 0001`, because the customer needs to confirm the number they are
sending data to. Masking keeps the first three and last four characters only;
input shorter than 8 characters is masked in full rather than echoed back, so
an unexpected value cannot leak. The buyer's own contact number is never
printed on a guest page, and full numbers appear only behind authentication:
the owner's Studio order page and the customer-account order page.

### Customer registration — no account enumeration

`POST /api/customer/auth/register` answers with the same neutral message
whether or not the address already has an account. When it does, the owner of
that address receives an email instead (a fresh verification link if the
account is still unverified, otherwise an "you already have an account" note
with the sign-in link) — an attacker probing addresses learns nothing from the
response, while a legitimate user who forgot they had signed up is still told
what to do. A concurrent duplicate insert (`CustomerAccountExistsError`) takes
the same neutral path. Expired sessions and one-time tokens are purged
opportunistically (at most hourly) so they never accumulate.

### Customer email delivery hardening

- `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM` are validated together: both unset → `not_configured`, one set / blank / malformed / CR-LF / injection → `invalid`, both valid → `configured`. See `src/lib/resend-config.ts`.
- `assertCustomerEmailDeliveryReady()` checks config **before** any account lookup, preserving anti-enumeration: known and unknown emails get same 503 when misconfigured.
- `sendCustomerEmail()` uses portable `AbortController` + `setTimeout` 10s, timer cleared in `finally` (no leaks, no unhandled rejections).
- Provider non-ok and fetch rejections/timeouts → typed 502 `CustomerEmailDeliveryError` with generic message, no body/key leak.
- `forgot-password` and `resend-verification` routes suppress **only** `CustomerEmailDeliveryError` after lookup, returning neutral `ok:true`; configuration errors (503) are not suppressed.
- Tests cover config cases, provider rejection, timeout/abort, 502/503 contracts, anti-enumeration, and no-leak assertions.

### Test credentials

The end-to-end tests mint a real encrypted `valmont_session` cookie using the
`SESSION_SECRET` the server was started with. **There is no test-only
authentication bypass in application code.** The session secret is generated per
CI run; `playwright.config.ts` refuses to run without a 32-character-plus
secret and provides no fallback. Tests never open the real `.data` files: they
use a separate directory, `.e2e-data` by default and overridable with
`E2E_DATA_DIR`. On CI that directory disappears with the runner, but **locally
it persists between runs** — it is not deleted afterwards. Delete it by hand if
you want a clean slate.

### Test status

Security claims are only worth what has actually been executed. Do not treat a
past total as a permanent fact — use the latest CI run on the pull request.

| Suite                           | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + integration (`npm test`) | Run in CI against a real PostgreSQL 16 service (`STUDIO_TEST_DATABASE_URL`), with the Drizzle migrations applied first via controlled `db:migrate` + `db:verify` (full journal validation, no timestamp ordering). The coordinated-import suite injects a failure at every checkpoint and covers lease locking, expired-lease recovery, obsolete-token fencing, monotonic generations, and — with deterministic latches, no sleeps — both orderings of the PostgreSQL fence race (replacement fence first, and obsolete transaction winning the fence row lock). Without that variable the PostgreSQL files are reported as skipped, never as passed. Additional coverage: `resend-config`, `customer-email` (config, rejection, timeout, 502/503, anti-enumeration, no-leak), `api` (opaque 500 for arbitrary errors, typed statuses, Zod 400, JSON 400), `bounded-json` (no echo), `migration-bootstrap` (hash/timestamp sync, journal order regression). |
| End-to-end (`npm run test:e2e`) | Playwright schedules **11 tests across 2 projects (22 scheduled tests)** — `desktop-chromium` and `iphone` — against a production build on a throwaway SQLite database. Includes the two-tab 409 conflict tests, the Nigeria/NGN/Africa/Lagos reopen test, and a no-sideways-scroll assertion in both projects. The Phase 1 CI workflow (active since `158f601`) installs Chromium and runs this suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

CI runs the unit, integration, PostgreSQL, Playwright and container-build jobs
on every push and pull request via `.github/workflows/ci.yml`; there is no
longer any workflow that needs to be moved or activated by a human.
