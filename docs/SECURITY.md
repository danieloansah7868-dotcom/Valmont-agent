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

Studio mutations require requireApiSessionUser (401), assertCsrf + assertSameOrigin (403), rate limit 30/min (429), readBoundedJson stream limits 1MB/25MB (413), Zod validation (no javascript: / data: / credential URLs, strict #RRGGBB, E.164), generic 404 for missing vs foreign draft, no server-side fetch of user URLs, no dangerouslySetInnerHTML, canonical deterministicUuid for owner, no asset URLs in v1, no payment execution (plannedPaymentMethods future-only).
