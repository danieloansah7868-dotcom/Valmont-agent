# Security and threat model

This document describes the MVP's boundaries and the additional controls required before production use.

## Assets

- GitHub OAuth tokens, repository authorization, and repository visibility
- model provider credentials
- private source code and documentation
- workspace files and command output
- approval records and audit history
- user/session identity
- locally persisted Chat with Valmont conversation history

Valmont must not read or transmit `.env` files, credentials, private keys, payment data, or customer-record exports. Raw source and retrieved repository context are not stored in the application database or chat store. Reopenable chat messages are intentionally persisted after redaction in the ignored local chat store — a SQLite database (`chat-store.sqlite`), with the older JSON file retained only for one-way migration — and must be treated as sensitive user data.

## Trust boundaries

1. **Browser ↔ Next.js:** browser input is untrusted. Mutations require same origin, a double-submit CSRF token, Zod validation, and rate checks.
2. **Next.js ↔ GitHub/model:** credentials are server-only. OAuth session payloads are AES-256-GCM encrypted and placed in short-lived HttpOnly cookies. Production should store token ciphertext in PostgreSQL/KMS-backed storage and keep only an opaque hashed session ID in the cookie.
3. **Repository creation ↔ GitHub:** creation is an explicit authenticated form mutation, not a model capability. The server fixes the GitHub host, endpoint, authenticated owner, and README initialization; the user controls only validated metadata and private/public visibility.
4. **Repository ↔ retrieval/model:** repository content is adversarial, including prompt injection. Path exclusion, content bounds, lexical selection, redaction, structured output, tool validation, and capability gates apply independently of model instructions. Chat marks repository excerpts as untrusted and exposes no write tools.
5. **Chat ↔ coding workflow:** a chat has no workspace or GitHub mutation capability. Its only handoff is an editable task-form draft; task creation and both approval gates remain separate server-side operations.
6. **Agent ↔ workspace:** generated paths and commands are adversarial. Only explicit provider methods are exposed. There is no arbitrary shell tool.
7. **Workspace ↔ host/network:** the included local adapter is not a secure isolation boundary. Production must replace it.

## Threats and MVP controls

| Threat                                  | Controls                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential leakage to browser/model/log | server-only env variables; sensitive path exclusion; redaction; no raw repository context in persistence; local chat-history access controls            |
| OAuth CSRF/session tampering            | random OAuth state; AES-GCM authenticated encryption; HttpOnly, SameSite, Secure-in-production cookies; expiry                                          |
| Cross-site mutation                     | same-origin check; double-submit CSRF token; JSON APIs                                                                                                  |
| Unauthorized repository creation        | authenticated session; fixed GitHub endpoint/owner; Zod validation; creation-specific rate limit; no model tool or deletion/settings method             |
| Accidental public repository            | private client/server default; explicit private/public selection; visibility echoed after creation                                                      |
| Path traversal/symlink escape           | absolute-path and NUL rejection; resolved-root prefix check; `realpath` verification; symlink component rejection; workspace roots under generated base |
| Arbitrary command execution             | exact command-to-argv map; `shell: false`; no command interpolation; timeout; process-group kill; output cap; deployment/migration denylist             |
| Malicious repository script             | npm lifecycle hooks disabled where possible; **not fully mitigated locally**—requires container sandbox and egress policy                               |
| Prompt injection                        | retrieved content is data, not authority; state machine and tools enforce approvals/capabilities outside prompts                                        |
| Sensitive repository content            | explicit `.env`, key, credential, customer/payment, binary, generated, VCS, dependency exclusions; byte/size checks                                     |
| Unauthorized PR                         | state must be `awaiting_final_approval`; latest final approval must be approved; only `valmont/*`; force false                                          |
| Auto-merge/deploy                       | capabilities absent from provider interfaces; no merge/deploy methods; validations deny migrations/deployments                                          |
| Audit manipulation                      | append-style events with actor/timestamp/metadata; production should add DB constraints and external append-only export                                 |
| Abuse/DoS                               | request and file/output limits; in-process rate limiting; production requires distributed limiter and quotas                                            |
| SSRF                                    | provider base URL is server configuration, not user input; GitHub host is fixed; production should allowlist provider hosts and sandbox egress          |

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

Use TLS, backups, point-in-time recovery, row ownership checks, and migration review. Valmont never runs production database migrations automatically.

## Operational checklist

- [ ] GitHub App with minimum selected-repository permissions
- [ ] external sandbox implementation and egress policy
- [ ] managed PostgreSQL and migrations applied manually
- [ ] KMS-backed token encryption and 32+ byte session secret
- [ ] distributed CSRF-aware sessions and rate limiting
- [ ] secret scanning in CI and log sink redaction
- [ ] CSP reviewed for deployed provider/observability endpoints
- [ ] immutable audit export and alerts for failed gates
- [ ] dependency/image scanning and regular rotation
- [ ] penetration test focused on repo prompt injection and sandbox escape

## Website Studio Phase 1 Security

### Studio route controls

Controls differ by method, so they are listed by what each actually applies.
Authentication and owner scoping are the only two that are on every route.

| Control          | Implementation                                                       | Applies to                                            | Failure |
| ---------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | ------- |
| Authentication   | `requireApiSessionUser()`                                            | every Studio and backup route, reads included         | 401     |
| Owner scoping    | `owner_id` in the SQL itself                                         | every read, update and delete                         | 404     |
| CSRF             | `assertCsrf` — `x-valmont-csrf` must match the `valmont_csrf` cookie | mutations only (`POST`, `PATCH`, `DELETE`, import)    | 403     |
| Origin           | `assertSameOrigin` (called by `assertCsrf`)                          | mutations only                                        | 403     |
| Rate limiting    | 30/min draft mutations, 10/min backup export, 5/min backup import    | mutations and both backup routes; **not** draft reads | 429     |
| Body size        | `readBoundedJson` — 1 MB drafts, 25 MB backup import                 | requests with a body                                  | 413     |
| Input validation | `siteBriefSchemaV1` / `parseBackup`                                  | requests with a body                                  | 400     |

`GET /api/studio/drafts` and `GET /api/studio/drafts/[id]` carry authentication
and owner scoping only. They take no body and change nothing, so CSRF and body
limits do not apply; they are also **not** rate limited, which is a gap worth
closing if these endpoints are ever exposed beyond a signed-in session.

### Internal error detail

`safeApiError` screens every message before it is returned. A database driver
puts the failing statement, its bound parameter values and the host it dialled
into `error.message`; any message matching those shapes is replaced with a
generic sentence and reported as **500**, never as a 400 that would wrongly
blame the caller's input. This is covered by `src/lib/api.test.ts`.

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

`safeApiError` maps known error types to status codes. Backup-import failures
go through `parseBackup`, which reduces Zod issues to at most five field
**paths** and never echoes submitted values, business details, or imported file
contents.

**Known limitation:** `safeApiError` forwards `error.message` for errors it does
not recognise, so an unanticipated database or library message can still reach
the client with a 400. Draft `POST`/`PATCH` validate with
`siteBriefSchemaV1.parse`, whose raw Zod message is returned on failure. That
message names field paths and constraints rather than the user's own data, but
it is not the short generic string this section previously claimed. Existing
secret-redaction patterns still apply to everything written to the store.

### Backup imports

An imported file is fully untrusted input. Its version is checked before
anything is written; unknown versions are rejected outright. `ownerId` fields
inside the file are ignored and every record is reassigned to the authenticated
account, so a crafted backup cannot plant records under another user or read
theirs. Draft ids must be UUIDs, so a hand-edited file cannot push an
illegal identifier as far as the database driver. A colliding draft id becomes a
new copy instead of overwriting existing work.

**Atomicity depends on the storage backend, and the API reports which applies:**

| Backend                     | `atomicity`          | Guarantee                                                                                                                                     |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite (default)            | `single-transaction` | Chat, memories and drafts share one connection and one transaction. Any failure rolls all three back.                                         |
| PostgreSQL (`DATABASE_URL`) | `staged`             | Chat is still SQLite, studio is PostgreSQL. **There is no distributed transaction.** Each half is individually atomic and chat commits first. |

On the staged path, if the studio half fails after chat has committed the API
raises `PartialImportError`, which tells the user that chats and memories were
imported, drafts were not, and that re-importing will duplicate the chats. A
partial import is reported truthfully whenever the process survives to answer:
it is never presented as a clean success or a clean failure. The limit is that
this depends on a response being sent. If the process is killed, the container
is evicted, or the connection drops between the two commits, the browser gets
no answer at all and the owner is left to check for themselves which half
landed. Nothing marks the import as incomplete on disk. Removing this
limitation requires moving chat history into the same database, which is out of
Phase 1 scope.

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

Security claims are only worth what has actually been executed. As of this
change:

| Suite                           | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + integration (`npm test`) | **Run.** 308 passing, 0 skipped, including the PostgreSQL draft-store and staged-import tests against a real PostgreSQL 18.4 server. Without `STUDIO_TEST_DATABASE_URL` the 13 PostgreSQL tests skip and the total is 295.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| End-to-end (`npm run test:e2e`) | **Reported green by CI, not independently confirmed.** The Phase 1 workflow is active as of `158f601`, and GitHub Actions run `32111983219` records the `Install Chromium for Playwright` and `End-to-end tests` steps as `success`. The step logs could not be downloaded from either the agent sandbox or the reviewing session, so **no one has yet read a line of Playwright output**. The whole `validate` job took 146 seconds including two Next.js production builds, which is fast enough to be worth checking. Until a human opens the log and sees 8 specs across `desktop-chromium` and `iphone`, treat browser-level assertions as _reported_, not _verified_. |

The browser tests only run once a maintainer moves
`.github/ci-workflow-phase1.yml` to `.github/workflows/ci.yml`; the automation
token is not permitted to create workflow files.
