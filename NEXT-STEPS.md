# Follow-up items — status updated by production-hardening session (arena/01a05a32-valmont-agent)

Owner note: PR #10 was merged intentionally by the owner. It was not a mistake and
nothing about it needs to be reverted. The items below were follow-up housekeeping
caused by that merge; several have since been resolved by the Website Studio
final-corrections PR (which supersedes PR #9 and must not be merged before an
independent review).

---

## Production hardening — Resend + Migrations + Strict ApiError + CI (this branch)

This branch implements the production-hardening follow-up described in the Arena task:

### A. Resend config validation and safe email failures

- `src/lib/resend-config.ts` (new): validates `RESEND_API_KEY` + `NOTIFY_EMAIL_FROM` together — both unset → `not_configured`, one set/blank/malformed/CR-LF/injection → `invalid`, both valid → `configured`. Rejects blank, malformed (no `@`), CR/LF (`\r\n`), angle-bracket injection. Accepts plain and display-name senders.
- `src/lib/customer-email.ts`: uses portable `AbortController` + `setTimeout` 10s (not runtime-specific helper), timer cleared in `finally`, provider non-ok and fetch rejections/timeouts normalized to typed 502 `CustomerEmailDeliveryError` with generic message (no provider bodies/keys leak). Typed 503 `CustomerEmailConfigurationError` for misconfig.
- `assertCustomerEmailDeliveryReady()` checks config **before** any account lookup (anti-enumeration). `forgot-password` and `resend-verification` routes suppress only `CustomerEmailDeliveryError` after lookup, preserving neutral `ok:true`; config errors (503) are not suppressed.
- `compose.yaml` passes `RESEND_API_KEY`/`NOTIFY_EMAIL_FROM` through to app.
- Tests: `src/lib/resend-config.test.ts` (valid/invalid senders, states), `src/lib/customer-email.test.ts` (partial/blank/malformed/CR-LF/injection, provider rejection, timeout/abort, 502/503 contracts, no-leak, anti-enumeration, dev link).

### B. PostgreSQL migration verification — complete journal, never timestamp ordering

- `src/lib/db/migration-manifest.ts` (new): loads `src/db/migrations/meta/_journal.json`, validates version/dialect, sequential idx 0..n-1 matching position, unique tag/idx, when number, breakpoints boolean, file existence, computes SHA-256 per SQL file, never uses timestamp ordering. Regression: `0007_studio_domains` when earlier than `0006_studio_settings` but idx later.
- `src/lib/db/migration-verify.ts` (new): verifies ledger `drizzle.__drizzle_migrations` against manifest by hash + created_at, detects missing/unexpected/altered/duplicate hashes/timestamps, exact membership required.
- `src/lib/db/migration-readiness.ts` (new): safe readiness probe without leaking driver details, returns `not_configured`/`connected`/`unavailable`/`incomplete`/`complete`.
- Scripts:
  - `scripts/db-verify-local.ts` (new): no DB, validates manifest, hash format, non-empty SQL, regression ordering.
  - `scripts/db-verify.ts` (new): read-only, advisory lock attempt, ledger membership verification, fail-closed on incompatible ledger.
  - `scripts/db-migrate.ts` (new): requires `DATABASE_URL` with generic safe error, advisory xact lock 72707369, ensures drizzle schema/table, fail-closed on altered/unexpected/duplicate, applies missing in journal order splitting on `--> statement-breakpoint` via `tx.unsafe`, inserts ledger hash/when, re-verifies.
- `scripts/docker-init/0001_bootstrap_ledger.sql` (new): Docker-init-only bootstrap ledger row for immutable `0000_lazy_leopardon` with hash `3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249` timestamp `1786700718887` derived from source, inserted after `0000` lexical with `WHERE NOT EXISTS` guard. Ensures fresh volume reports complete for historic base only.
- `compose.yaml`: mounts `0000` + `0001` bootstrap ledger, passes Resend vars.
- `src/app/api/health/route.ts`: uses `checkMigrationReadiness()`, returns `dependencies.migrations: { status, expected, applied }` and degraded 503 when incomplete/unavailable, no internal leak.
- `package.json`: `db:migrate` → `tsx scripts/db-migrate.ts`, added `db:verify` and `db:verify:local`.
- Tests: `src/lib/db/migration-bootstrap.test.ts` derives 0000 hash/timestamp from source and confirms bootstrap SQL synchronized, plus journal-order regression.
- Docs: `docs/PRODUCTION.md` accurately states fresh volume initializes only historic base 0000 schema/ledger row, controlled release runs `npm run db:migrate` and `db:verify`, Valmont never runs prod migrations automatically, `/api/health` degraded when ledger incomplete/unavailable.

### C. Typed safe API errors

- `src/lib/api-errors.ts` (hardened): strict `ApiError` hierarchy with explicit statuses 400/401/403/404/409/413/429/502/503. Added `CustomerEmailDeliveryError` 502, `CustomerEmailConfigurationError` 503, `ChatNotFoundError`, `TaskNotFoundError`, etc.
- `src/lib/api.ts`: `safeApiError` trusts only `ApiError` instances, removes message heuristics (`Task not found`, `CSRF`, `Rate limit`, arbitrary `status`), Zod → 400, JSON syntax → 400, arbitrary DB/network/plain object → opaque 500 with generic message, screens even deliberate messages for internal patterns.
- Legacy routes updated to throw typed errors: `auth/signout`, `chat`, `memories`, `repositories/branches`, `tasks`, `customer auth/account`, `customer order claim`, GitHub provider, CSRF, bounded JSON, Studio backup/import/order/draft (`DraftConflictError` 409, `DraftNotFoundError` 404, `BackupValidationError` 400, `PartialImportError`/`ImportFailedError` 500 via `BadRequestError` with status override preserving ApiError identity, `ImportInProgressError`/`ImportLostLeaseError` 409 via `ConflictError`, `UploadRejected`/`AssetError` 400).
- Tests: `src/lib/api.test.ts` asserts opaque 500 for arbitrary message-bearing errors, plain object with status, driver errors, network errors, while typed ApiErrors preserve intentional statuses, Zod 400, JSON 400, no stack/path leak. `src/lib/studio/backup-route.test.ts` fixed to use hoisted mocks instead of `vi.resetModules` with partial mocks, preserving single shared `ApiError` identity. `src/lib/bounded-json.test.ts` updated to expect generic 400 without echoing body.

### D. CI

- `.github/workflows/ci.yml`: PostgreSQL 16 service, runs `db:migrate` → `db:verify` → `npm test` (with `STUDIO_TEST_DATABASE_URL`) → `format:check`/`lint`/`typecheck`/`db:verify:local` → `build`. Keeps workflow even if push rejected due to workflows permission.

### E. Docs

- `README.md`: controlled migration procedure, fresh-volume 0000 bootstrap, Resend requirements, strict safeApiError.
- `docs/PRODUCTION.md`: controlled rollout, no auto-migrate service, health degraded 503, Resend all-or-nothing validation, CI verification.
- `docs/SECURITY.md`: strict typed ApiError, no message heuristics, Resend header injection, migration tampering, email anti-enumeration, timeout cleanup, no-leak guarantees.
- `NEXT-STEPS.md` (this file): accurate description.

### Validation

- `npm run format:check` ✅
- `npm run lint` ✅ (max-warnings 0)
- `npm run typecheck` ✅
- `npm run db:verify:local` ✅ (10 entries, regression confirmed)
- `npm test` ✅ (642 passed, 40 skipped)
- `npm run build` ✅
- Focused: `customer-email`, `resend-config`, `migration-bootstrap`, `api`, `bounded-json`, `backup-route` ✅
- Health smoke: `DATABASE_URL` unset → degraded 503 with `migrations.status` (manual, operator)

---

## Website Studio Customer Accounts v1 — implemented on this branch

Customer accounts are optional and do not change guest checkout. The public
account flow now supports registration, sign-in/sign-out, email verification,
verification resend, password reset, secure hashed sessions, customer-only
order history, and post-checkout order linking. The feature is an explicit
owner opt-in per website: Step 5 of the website wizard has a "Customer
accounts" switch (`features.customerAccounts`, default off), and websites
without it show no Account link, attach no session at checkout, refuse order
claims, and expose nothing through `/account`. Customer accounts, sessions and
tokens are included in Studio backup v2 (hashes only — never plaintext
passwords, tokens, or payment credentials), and restoring never overwrites an
account that already exists. SQLite is provisioned locally
from the shared Studio store; PostgreSQL uses migration `0008` plus `0009`.
Email delivery stays behind `src/lib/customer-email.ts`: configure the existing
`RESEND_API_KEY` and `NOTIFY_EMAIL_FROM` values for delivery. In local
development, the absence of a provider exposes clearly marked one-time links;
in production, registration, verification resend, and password-reset requests
fail clearly with HTTP 503 until a sender is configured (now with full
all-or-nothing validation and injection rejection).

Before production, configure a real email sender, run the PostgreSQL migrations
manually via `db:migrate` + `db:verify`, and replace the in-process limiter with a distributed rate-limit
store. Live payments, deployment, and paid services remain intentionally
inactive.

## Customer order tracking and status notifications — implemented on this branch

Authenticated customers can open `/account/orders/[id]` to see an owner-scoped
order timeline, item details, and the current delivery status. Merchant status
changes and payment webhook transitions send a best-effort transactional email
to the checkout address when the production Resend configuration is present;
orders without an email remain valid guest orders but cannot receive email
updates.

---

## 1. Fix the formatting on `main`

**Status: resolved.** The final-corrections branch fixed the formatting on
`src/app/page.tsx`, `src/components/app-nav.tsx` and `src/components/app-shell.tsx`
(they were inherited unformatted from `main` at `df702ff`). `npm run format:check`
passes on the branch, so the new PR's `validate` check is green. `main` itself is
still left untouched, per the standing rule of no changes without explicit
permission — merging the new PR brings the fix in.

---

## 2. Require checks to pass before a pull request can be merged

**Status:** not done, for discussion.

PR #10 was merged while its `validate` check was failing. That was the owner's
deliberate decision and is entirely allowed.

Worth deciding whether GitHub should _block_ merging when checks fail, as a
guard against merging a genuine failure by accident on some future day. This is a
branch-protection setting on `main` and is reversible at any time.

This is a policy decision for the owner, not a code change. Options range from
"leave as is" to "block merges until checks pass, with an override for the owner".

---

## 3. Activate the Phase 1 CI workflow

**Status: done.** The workflow was activated in commit `158f601`
(`.github/ci-workflow-phase1.yml` moved to `.github/workflows/ci.yml`; the
staging file was removed). CI now runs on every push and pull request:

- `npm ci`, `format:check`, `lint`, `typecheck`, `db:verify:local`
- Drizzle migrations against a throwaway **PostgreSQL 16 service** via controlled `db:migrate` + `db:verify` (full journal validation, no timestamp ordering), then
  `npm test` with `STUDIO_TEST_DATABASE_URL` pointing at it (the PostgreSQL
  draft-store and coordinated-import suites run for real, including
  lease-lock, expired-lease recovery and checkpoint rollback tests)
- `npx playwright install --with-deps chromium`, then `npm run test:e2e`
  (11 tests × desktop-chromium and iphone projects = 22 scheduled tests)
- `npm run build`
- a `container` job that runs `docker build`

Nothing needs to be moved or activated by a human anymore.

---

## 4. Re-run Phase 1 checks against the current `main`

**Status: done by the final-corrections PR.** PR #9's checks were computed
against the old `main` (`6131e97`) before PR #10 landed. The final-corrections
branch is based on the current `main` (`df702ff`) and carries the complete Phase 1
implementation plus the corrections; its own PR gets freshly computed checks
against current `main`, so the green ticks reflect the actual head. PR #9 is
superseded and left open for reference.

---

## Re-type the legacy error fallback in `safeApiError`

**Status: resolved in this branch.** `safeApiError` now trusts only explicit `ApiError` instances, removes message-text heuristics (`Task not found` → 404, `CSRF` → 403, `Rate limit` → 429, arbitrary `status` property), maps Zod → 400, JSON syntax → 400, arbitrary DB/network/plain object → opaque 500. Legacy routes now throw typed errors with intentional statuses 400/401/403/404/409/413/429/502/503, preserving `ApiError` identity (no `vi.resetModules` partial mocks). See `src/lib/api-errors.ts` and `src/lib/api.ts`.

---

## Website Studio Phase 4 — public site, orders, notifications

**Status: implemented on this branch.** Phase 4 adds the customer-facing
website, merchant order management, new-order alerts, product photos and
visual polish on top of the Phase 3 checkout.

What it adds:

- A public shop at `/s/[draft-id]` (unguessable UUID, no login). Copy-share-
  link on the dashboard and in the wizard. Open Graph title/description/image
  for WhatsApp previews.
- Order detail at `/studio/orders/[id]` with Preparing → Out for delivery →
  Delivered (plus Cancelled / Refunded), filter tabs and count badges.
- In-tab new-order ping and optional chime while Studio is open. Email via
  Resend and WhatsApp/SMS via Twilio, Arkesel or Termii when those keys are
  set; otherwise skipped.
- Per-item product photos (same resize pipeline as logo/photos) and one-item-
  per-line menu parsing with a live preview.
- Customer-facing payment label “Mobile Money, Card and Bank transfer”.
  Manual MoMo/card/bank boxes are hidden when Valmont Pay is on.

## Website Studio Phase 3 — payments & checkout

**Status: merged and in use.** Phase 3 adds a real basket and checkout to a
Studio shop, backed by Valmont Pay with a local test-mode simulator.

What it adds:

- Priced catalogue (`items`) and a `payments` config on the Site Brief
  (methods, delivery fee/minimum/free-above, order notifications, checkout
  note). Legacy name-only `products` are auto-migrated into `items` on read.
- A new wizard **Step 5 "Payments and delivery"**, and Step 4 now takes prices
  inline (`"Jollof Rice - 45, Banku - 30"`).
- A working basket + inline checkout in the preview, a public `POST
/api/studio/drafts/[id]/checkout` that **re-prices every basket server-side**
  (never trusting a client price), a `POST /api/payments/webhook` keyed on an
  unguessable per-order access code, and `/pay/[code]` + `/orders/[id]/confirmed`
  pages.
- An orders store (SQLite + PostgreSQL) and Drizzle migration `0004` for the
  `studio_orders` table.
- Test mode vs live mode is decided by `VALMONT_PAY_API_URL` +
  `VALMONT_PAY_API_KEY` (see `.env.example`). With them unset, no real money
  moves.

Deliberately **not** in this phase (follow-ups): sending the order
notifications (fields exist, no send logic yet), a merchant "mark fulfilled"
action, HMAC webhook signature verification (placeholder until Valmont Pay
publishes its signing scheme), per-item image upload UI, including orders in
backup/export, and Playwright e2e coverage of the checkout flow.

---

## Unchanged status

**Website Studio Phase 1 has not been merged or deployed.** The final-corrections
PR still requires an independent review from a separate Arena session before any
merge decision; it states this on the PR itself and must not be merged by the
same session that authored it.
