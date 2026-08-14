# Security and threat model

This document describes the MVP's boundaries and the additional controls required before production use.

## Assets

- GitHub OAuth tokens and repository authorization
- model provider credentials
- private source code and documentation
- workspace files and command output
- approval records and audit history
- user/session identity

Valmont must not read or transmit `.env` files, credentials, private keys, payment data, or customer-record exports. Raw source content is not stored in the application database.

## Trust boundaries

1. **Browser ↔ Next.js:** browser input is untrusted. Mutations require same origin, a double-submit CSRF token, Zod validation, and rate checks.
2. **Next.js ↔ GitHub/model:** credentials are server-only. OAuth session payloads are AES-256-GCM encrypted and placed in short-lived HttpOnly cookies. Production should store token ciphertext in PostgreSQL/KMS-backed storage and keep only an opaque hashed session ID in the cookie.
3. **Repository ↔ retrieval/model:** repository content is adversarial, including prompt injection. Path exclusion, content bounds, lexical selection, redaction, structured output, tool validation, and capability gates apply independently of model instructions.
4. **Agent ↔ workspace:** generated paths and commands are adversarial. Only explicit provider methods are exposed. There is no arbitrary shell tool.
5. **Workspace ↔ host/network:** the included local adapter is not a secure isolation boundary. Production must replace it.

## Threats and MVP controls

| Threat                                  | Controls                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential leakage to browser/model/log | server-only env variables; sensitive path exclusion; redaction; no raw prompts/source in DB                                                             |
| OAuth CSRF/session tampering            | random OAuth state; AES-GCM authenticated encryption; HttpOnly, SameSite, Secure-in-production cookies; expiry                                          |
| Cross-site mutation                     | same-origin check; double-submit CSRF token; JSON APIs                                                                                                  |
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

- **Plan approval** authorizes only the plan's workspace edits and allowlisted validation commands.
- **Final approval** separately authorizes branch, commit, and pull-request creation.
- A rejection cancels the task. Reopening requires a new/revised task.
- Approvals are checked in domain code, not only hidden/disabled UI.
- Pull requests remain open for human review. Valmont does not merge or deploy.

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
