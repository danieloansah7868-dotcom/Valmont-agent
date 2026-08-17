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

Valmont must not read or transmit `.env` files, credentials, private keys, payment data, or customer-record exports. Raw source and retrieved repository context are not stored in the application database or chat store. Reopenable chat messages are intentionally persisted after redaction in the ignored local chat JSON file and must be treated as sensitive user data.

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

### Every Studio route

| Control          | Implementation                                                       | Failure |
| ---------------- | -------------------------------------------------------------------- | ------- |
| Authentication   | `requireApiSessionUser()`                                            | 401     |
| CSRF             | `assertCsrf` — `x-valmont-csrf` must match the `valmont_csrf` cookie | 403     |
| Origin           | `assertSameOrigin`                                                   | 403     |
| Rate limiting    | 30/min draft mutations, 10/min backup export, 5/min backup import    | 429     |
| Body size        | `readBoundedJson` — 1 MB drafts, 25 MB backup import                 | 413     |
| Input validation | `siteBriefSchemaV1` / `parseBackup`                                  | 400     |

### Owner isolation

Every read, update, and delete is scoped by `owner_id` in the SQL statement
itself, not filtered afterwards. A draft belonging to somebody else and a draft
that does not exist produce the **same generic 404 with the same body**, so the
API cannot be used to discover which ids are real. The end-to-end suite asserts
this by comparing the two responses byte for byte. Owner identity comes from the
encrypted session and is mapped through `deterministicUuid("github:" + id)`; it
is never taken from the request body.

### Concurrency safety

Draft updates are a single conditional `UPDATE ... WHERE id AND owner_id AND
revision ... RETURNING`. Zero returned rows is always an error (409 or 404),
never a success. Two writers on the same revision cannot both win, and no
writer's changes are discarded without the owner being told.

### Untrusted input

- **URLs** — `isHttpsSafeUrl` accepts `https` only, and rejects embedded
  credentials, `localhost`, `127.*`, `10.*`, `192.168.*`, and `169.254.169.254`.
  This blocks `javascript:`, `data:`, and SSRF-shaped values. Valmont never
  fetches a URL a user typed; links are rendered with
  `rel="noopener noreferrer nofollow"` only after passing the same check the
  schema applies.
- **Text** — the preview renders text as text. There is no
  `dangerouslySetInnerHTML` anywhere in the Studio, so `<img src=x onerror=...>`
  is displayed literally, never executed. A browser test asserts this.
- **Colours** — strict `#RRGGBB`. **Phones** — E.164 `/^\+\d{8,15}$/`.
- **Assets** — `assetStatus` is `z.literal("not_provided")`: a marker, not a
  URL. There is no upload control and no arbitrary asset URL can be stored.

### Error and log hygiene

`safeApiError` maps known error types to status codes and returns short, generic
messages. Zod issues are reduced to at most five field **paths**; submitted
values, business details, and imported file contents are never echoed into a
response or a log line. Existing secret-redaction patterns still apply to
everything written to the store.

### Backup imports

An imported file is fully untrusted input. Its version is checked before
anything is written; unknown versions are rejected outright. `ownerId` fields
inside the file are ignored and every record is reassigned to the authenticated
account, so a crafted backup cannot plant records under another user or read
theirs. A colliding draft id becomes a new copy instead of overwriting existing
work. The import is one transaction, so a partial write cannot leave chats,
memories, and drafts inconsistent.

### No payments, no payment data

Phase 1 executes no payment of any kind. `plannedPaymentMethods` is a small
enum of future-planning preferences, stored alongside `PAYMENT_PLANNING_NOTICE`
which states plainly that nothing is connected. Card numbers, mobile-money PINs,
and merchant credentials have no field in the schema, are stripped by Zod if
submitted, and are never stored or logged. A test asserts their absence from
parsed output.

### Test credentials

The end-to-end tests mint a real encrypted `valmont_session` cookie using the
`SESSION_SECRET` the server was started with. **There is no test-only
authentication bypass in application code.** The session secret is generated per
CI run; `playwright.config.ts` refuses to run without a 32-character-plus
secret and provides no fallback. Tests use a throwaway database directory and
never open the real `.data` files.
