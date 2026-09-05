# Follow-up items — status updated by production-hardening session (arena/01a05a32-valmont-agent)

## Owner's idea backlog (2026-09-03)

1. ~~Stage 5 — per-client TechChief API key~~ — **merged (PR #49**, merge commit `1952e36`**)**: each website stores its own encrypted key, the engine picks the provider per order, Test connection shows the balance, and live checkout opens only after the probe passes. Details under _Data Bundles_ below.
2. ~~Client manages own float~~ — **merged (PR #49)**: the Bundle delivery card shows that website's wallet balance, the cached TechChief price list and the bundles TechChief cannot deliver, and the merchant gets a low-balance email when TechChief answers 402 or reports the float is low.
3. Client admin page (Stage 6): a login for the shop owner (not the agency team) with orders, delivery status, Retry, API key + balance. Changes the earlier "agency team only" decision — owner to confirm login method (phone OTP or email).
4. Sub-agents (Stage 7, DataMartGH style): shop owner creates agents with their own prices and wallets; agent orders tracked separately; commission report.
5. ~~Checkout caps: max 10 units per line / 20 per order; cap rows per recheck pass~~ — **done on branch `arena/01a06950-valmont-agent`** (Stage 4b, PR pending review): `MAX_BUNDLE_UNITS_PER_LINE` / `MAX_BUNDLE_UNITS_PER_ORDER` in `bundles.ts`, one shared `bundleOrderCapError` counter, a 400 in the checkout route before any order row, the storefront "+" stopping at 10 and its Checkout button disabled with the same sentence over 20, and `MAX_PROCESSING_POLLS_PER_PASS = 25` per recheck pass (oldest `updated_at` first).
6. ~~Masked delivery line on the customer-account order page~~ — **done on the same branch** (Stage 4b): `/account/orders/[id]` renders `guestBundleDeliverySummary` for bundle orders only, `data-testid="bundle-delivery-line"`, read-only (no recheck, so a customer refresh cannot spend the shop's TechChief allowance).
7. Connectors (roadmap priority 2).
8. Lovable-style chat features (roadmap priority 3).
9. Real deployment of main (migrations 0011 + 0012) so there is a preview link that does not die with a sandbox.
10. Valmont-Web (valmontweb.com) static demos stay in their own repo; drag-and-drop upload is fine there only.

Owner note: PR #10 was merged intentionally by the owner. It was not a mistake and
nothing about it needs to be reverted. The items below were follow-up housekeeping
caused by that merge; several have since been resolved by the Website Studio
final-corrections PR (which supersedes PR #9 and must not be merged before an
independent review).

## Data Bundles — Stages 1–5 merged, Stage 4b on branch, Stage 6 pending

Stages 1–2 (catalogue field `bundle: { network, dataMb, validity }`, superRefine,
starter merge, wizard table, readiness v2, storefront tabs, Ghana mobile
single-source validation, network-mismatch warning only), Stage 3 and Stage 4
are on `main`.

**Stage 3 — merged** as PR #44 (merge commit `b260c9c`) plus review fixes in PR
#45 (merge commit `79f23b5`). It adds the `recipient_phone` column (migration
`0011`), a required recipient number and an optional buyer contact at checkout,
and **Valmont Pay only / no delivery** for bundle shops (superRefine + wizard +
checkout route).

Carried by the #45 review fixes:

- The guest confirmation page `/orders/[id]/confirmed` is unauthenticated, so it
  prints no phone number except a masked recipient line (`024 ••• 0001`); full
  numbers appear only on authenticated owner/customer pages.
- Stale bundle configs saved before the online-only rule are repaired on read in
  `normalizeBrief`, so the owner's next autosave cannot freeze.
- The non-bundle `customerPhone` minimum length (6) was restored in the checkout
  route, which the optional-field change had dropped.
- **Decision:** the buyer's own contact accepts any country (diaspora buyers),
  while the recipient stays Ghana-mobile-only.

**Stage 4 — merged** as PR #47 "feat(studio): bundle delivery engine with
simulator (stage 4)" (merge commit `2d033ae`):

- Migration `0012_studio_deliveries` adds `studio_deliveries`: one row per
  purchased bundle **unit** (`unique(order_id, line_index, unit_index)`), a
  snapshot of what was sold (network/size/validity, full recipient — server
  side only) plus engine state (`provider`, `status`, `attempts`,
  `provider_ref`, `last_error`, `delivered_at`). Per-unit rows keep partial
  delivery trackable and never let a Retry resend units that went through.
- `src/lib/studio/bundle-delivery.ts` holds the `BundleDeliveryProvider`
  contract, the default **SimulatedProvider** (accepts as `processing`,
  reports `delivered` on the next status check; rehearsal hooks: recipient
  ending `0000` always fails, `9999` stays processing for 60 s via a
  timestamped `sim-slow-` reference), the **TechChief stub** (which failed
  every send loudly — replaced by the real provider in Stage 5), a fail-closed
  answer to unknown
  `BUNDLE_DELIVERY_PROVIDER` values, the dual SQLite/PostgreSQL stores, and
  the engine. Invariants I1–I6 are documented in the module header and each
  has a dedicated test (`bundle-delivery.test.ts`):
  I1 paid-first **and live-money safety** (a live-money bundle checkout is
  refused with 409 before any order row while no live provider exists, and
  the engine backstop never dispatches a live order through a non-live
  provider — `bundleDeliveryAvailability().live` is false for everything
  connected today), I2 idempotent **also under concurrency** (unique unit
  index + atomic `claimForDispatch`, so a webhook and a simultaneous page
  load can never send the same unit twice), I3 delivered-is-terminal, I4
  failure isolation (owner-retryable failures, never thrown into the payment
  path, one aggregated merchant alert per engine pass), I5 bundle-only
  (other website types untouched), I6 guest privacy.
- Checkout snapshots `bundle` metadata into the order lines (data-bundles
  sites only; legacy orders resolve from the live catalogue).
- The payments webhook fires `dispatchBundleDeliveriesForOrder` immediately
  after `markPaid`, **fire-and-forget** — the webhook still answers 200 even
  when the provider is down.
- `recheckBundleDeliveriesForOrder` runs on order-page loads (owner page and
  guest confirmation page), recovering rows an outage prevented the webhook
  from creating and polling in-flight rows; it never throws.
- The owner order page shows a **Bundle delivery** panel (per-unit statuses,
  attempts, provider reference, last error) with a Retry button routed to
  `POST /api/studio/orders/[id]/bundle-deliveries/retry`; the guest
  confirmation page shows one masked aggregate line (no full numbers, no
  provider references, no error internals). `notifyMerchantDeliveryFailed`
  sends the merchant one aggregated alert per failing engine pass.

**Stage 5 — merged** as PR #49 (merge commit `1952e36`, head `b4a5a20`): the
real per-website TechChief connection and delivery adapter. The TechChief stub is gone; nothing else in the Stage 4 engine changed
shape, so all six invariants still hold and their tests were not touched.

- Migration `0014_studio_integrations` adds `studio_integrations` — one row per
  `(draft_id, provider)` behind a **unique index**, holding `api_key_enc` (the
  same AES-256-GCM envelope as `payment-settings.ts`, keyed by
  `SESSION_SECRET`), a nine-character `key_prefix`, `webhook_secret_enc`,
  `status`, `wallet_balance numeric(12,2)`, `low_balance`, `account_status`,
  `last_error`, `bundles_json`, `bundles_synced_at` and the hourly budget
  counters (`poll_window_start`, `poll_count`). Foreign keys to `studio_drafts`
  and `users` cascade; SQLite has none, so `SqliteStudioDraftStore.delete`
  removes the connections explicitly. The same migration adds
  `studio_deliveries_provider_ref_idx` for the webhook's lookup.
- `src/lib/studio/techchief.ts` is the HTTP client only: `dev_wallet.php`,
  `dev_bundles.php`, `dev_order.php`, `dev_status.php` under a fixed base URL,
  `X-API-Key` auth, a 15 s `AbortController` timeout on every call, rate-limit
  header parsing, and a `TechChiefResult<T>` that classifies failures
  (`rejected` / `unreachable` / `timeout` / `invalid` / `budget`) instead of
  throwing. It owns the network mapping (`mtn → MTN`, `telecel → Telecel`,
  `airteltigo → AirtelTigo`), Ghana phone normalization and
  `matchTechChiefBundle` (`Math.round(sizeGb * 1024) === dataMb`, `* 1000`
  fallback).
- `src/lib/studio/integrations.ts` is the store plus service layer:
  **probe before store** (`connectTechChief` only writes a row when TechChief
  answers `apiActivated` and `accountStatus: "active"`, so a bad key leaves
  nothing behind and never overwrites a good one), the 50/hour poll budget with
  orders always allowed the remaining headroom, the 24 h bundle cache,
  `techChiefConnectionView` (which has **no key field**), and
  `unmatchedBundleItems` (priced catalogue items TechChief cannot deliver, with
  the reason).
- Routes: `GET/PUT/DELETE
/api/studio/drafts/[id]/integrations/techchief`, `POST …/test` (balance),
  `POST …/sync-bundles`, and `POST /api/studio/orders/[id]/bundle-deliveries/
recheck` (the owner's **Check status now**). All four connection routes share
  one preamble — authenticate → CSRF on mutations → owner rate limit →
  owner-scoped draft read — so somebody else's website and a made-up id both
  answer 404.
- `resolveProviderForOrder(order)` picks per order: a **live** order with a
  `verified` connection gets `TechChiefProvider` built from that website's own
  key; everything else — **including every test-mode order, key or no key** —
  gets the configured provider, i.e. the simulator. Checkout now asks
  `bundleDeliveryAvailabilityForDraft(draftId)` instead of the server default,
  so live bundle checkout opens per website as soon as that website is
  verified and stays 409 while it is not.
- `TechChiefProvider` keeps its config in ECMAScript private fields (`#config`)
  because TypeScript `private` fields are still enumerable and
  `JSON.stringify(provider)` would have printed the key. An unknown outcome
  (timeout, 5xx) fails the row with _"check your TechChief dashboard before
  retrying"_ — **no automatic resend anywhere**.
- Webhook `POST /api/bundle-delivery/techchief/webhook?integration=<uuid>`:
  with a stored secret the raw body must carry a matching hex HMAC-SHA256 in
  `X-TechChiefX-Signature` (constant-time compare) and the signed path does
  database work only; without one the callback is a hint and the status is
  confirmed against `dev_status.php` inside a 6 s deadline. Either way amounts,
  references and phone numbers are re-read from the database, the delivery's
  order must belong to the integration called back, and `delivered` never
  changes.
- Studio UI: the **Bundle delivery** card
  (`src/components/studio/techchief-connection.tsx`) on the draft page —
  connect / test / sync / remove, balance, low-balance warning, bundle cache
  age, the unmatched-item list, the webhook URL to paste, and the request
  budget — plus a **Check status now** button beside Retry on the owner's order
  page. Readiness v2 gained `bundleDelivery` (`bundleDeliveryDependency` +
  `computeLiveSalesReadiness`): a data-bundles shop is not ready for live sales
  until its own connection is verified, and a dependency that does not apply
  never blocks.
- Poll throttling (the first Stage 4 review note) is in: one real poll per row
  per 10 minutes, 6 hours for rows older than a day, gated on `updated_at`.
  Because a skipped poll must not look like a fresh answer, `checkStatus`
  returns `{ status, polled }` and the engine calls the new `touchProcessing()`
  heartbeat only when a request actually went out — without it a row polled at
  T+11 min would keep its old `updated_at` and every later recheck would pass
  the gate.

**Stage 4b — implemented on this branch** (`arena/01a06950-valmont-agent`, PR
open, **not merged**): the two safety items the Stage 4 review asked for and
Stage 5 deliberately left out — backlog items 5 and 6.

- `src/lib/studio/bundles.ts` exports `MAX_BUNDLE_UNITS_PER_LINE = 10`,
  `MAX_BUNDLE_UNITS_PER_ORDER = 20`, the exact refusal sentence
  `BUNDLE_ORDER_CAP_MESSAGE` (built from the two numbers so it cannot drift
  away from them) and `bundleOrderCapError(lines)` — the **one** place the caps
  are counted, so the storefront and the checkout route cannot disagree about
  what "too many" means.
- The checkout route refuses an over-large data-bundles basket with **400** and
  that exact message, counted after the lines are re-priced from the catalogue
  but **before** the totals, before the payment rail is chosen and before any
  order row exists — so there is nothing to undo. The check sits inside
  `if (isBundleSite)`: every other website type may still order 999 of a line.
- `bundle-shop.tsx`: the "+" stops at 10 per bundle (clamped in `setQty`, so a
  stuck button cannot build an order the server would refuse), and over 20
  units total the Checkout button is rendered **disabled** with the same
  sentence above it (`data-testid="bundle-cap-message"`); `placeOrder` guards
  too, for a form opened before the basket grew past the cap.
- `refreshProcessingRows` — the polling half of
  `recheckBundleDeliveriesForOrder` — asks a provider about at most
  `MAX_PROCESSING_POLLS_PER_PASS = 25` rows per pass, **oldest `updated_at`
  first**, so a big order works through its queue fairly instead of always
  re-asking about the newest top-ups. Rows that cannot be polled yet (no
  provider reference) are skipped and do **not** consume the budget, otherwise
  one stuck row would hold a slot at the front of the queue forever. This
  bounds a single pass only: TechChief's 50-request hourly budget and the
  10-minute per-row throttle still apply on top. The simulator and every
  Stage 5 TechChief behaviour are unchanged.
- `/account/orders/[id]` now shows the masked `guestBundleDeliverySummary` line
  for bundle orders only (`data-testid="bundle-delivery-line"`) — total data,
  top-up count, delivered count, masked recipient — with no full number, no
  provider reference and no error text. It **reads** the rows instead of
  rechecking them, so a customer refreshing their own order page cannot spend
  the shop's hourly TechChief allowance.
- Also carried in this branch: the `syncTechChiefBundles` comment said a sync
  "costs 3 of the 60 hourly slots" — it is **4**, one per network (MTN,
  AirtelTigo, Telecel, BigTime).

Still open: nothing from the Stage 4 review notes. Stage 6 needs one decision
from the owner first (login method and roles — see the backlog item 3).

Stage 6: analytics, rate-limits, fraud checks, documentation polish.

**Review rules (from the Stage 4 review):**

- Never delete or rewrite existing tests to make room for new ones; if a
  mock setup conflicts, add a new describe block or a new `*.test.ts` file
  beside it.

---

## Deep-scan remediation — branch `arena/01a06135-valmont-agent`

Every finding from the deep scan of `dc0bd0a` is addressed on this branch.
Nothing here touches `main`; merge only after an independent review.

| Id  | Finding                                                                    | Fix                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Emailed links / Valmont Pay return URL built from `request.nextUrl.origin` | `publicOrigin()` in `src/lib/auth-redirect.ts` (APP_URL first) at all eight call sites; Playwright starts the server with `APP_URL`; route tests assert the emitted origin.                                                                                               |
| H2  | `SESSION_SECRET` never strength-checked                                    | `src/lib/session-secret.ts` policy (≥ 32 chars, placeholder list/patterns) enforced by `sessionKey()` (typed 503) and `config.ts` (health lists it as missing). `.env.example` ships it empty.                                                                            |
| H3  | Domain store keyed on `USE_POSTGRES_FOR_CHAT`; test wrote real `.data/`    | `getDomainStore()` keys on `DATABASE_URL`; `domains.test.ts` uses a temp SQLite store.                                                                                                                                                                                    |
| M1  | Custom-domain claim had no ownership proof                                 | Per-website TXT token + exact CNAME (`src/lib/studio/domain-verification.ts`), hostname grammar (400), cross-tenant uniqueness (409), no IP fallback, 24 h background re-check from `src/proxy.ts`, migration 0010 columns.                                               |
| M2  | Test-mode orders indistinguishable from live                               | `studio_orders.payment_mode` (SQLite `ensureColumn`, PG migration 0010), stamped by checkout, `PaymentModeBadge` on order views, excluded from analytics with an explicit count.                                                                                          |
| M3  | Live selected + incomplete keys → simulator + refused webhook              | `onlinePaymentAvailability()`; checkout answers 409 for online methods before any order exists; readiness reports `dependencies.payments = live_misconfigured`.                                                                                                           |
| M4  | Compose missing runtime vars; `NEXT_PUBLIC_*` not a build arg              | `compose.yaml` passes `TRUST_PROXY` (default true), Valmont Pay, payment admins, platform host, SMS/WhatsApp, workspace provider; `NEXT_PUBLIC_STUDIO_PLATFORM_HOST` via `build.args` + Dockerfile `ARG`.                                                                 |
| M5  | Plain `Error` + `.status` became opaque 500                                | `OrderTransitionError`, `ConflictError`/`TaskNotFoundError` in workflow, `ForbiddenError` in task store, `ChatNotFoundError` in chat store; route tests cover the statuses.                                                                                               |
| M6  | `DockerWorkspaceProvider` unreachable                                      | `VALMONT_WORKSPACE_PROVIDER=local\|docker` in `createWorkspaceProvider()`; unknown values fail at startup; documented in `docs/PRODUCTION.md`.                                                                                                                            |
| L1  | Dead `payment-admin.ts`                                                    | Deleted with its test and the `PAYMENT_SETTINGS_ADMIN_LOGINS` example.                                                                                                                                                                                                    |
| L2  | Eight legacy routes used `request.json()`                                  | All use `readBoundedJson`; the webhook streams through `readBoundedText`.                                                                                                                                                                                                 |
| L3  | Docker `HEALTHCHECK` hit readiness                                         | `/api/health?probe=live` liveness; HEALTHCHECK uses it; readiness adds the payments dependency and `cache-control: no-store`.                                                                                                                                             |
| L4  | Custom domains absent from backups                                         | v2 backup `domains` section (no tokens); import re-attaches as `pending` following remapped draft ids, skips taken hostnames, reports `customDomains`/`skippedDomains`; PostgreSQL restore no longer deletes-and-reinserts drafts (which cascaded to orders and domains). |
| L5  | Registration leaked account existence; expired rows never purged           | Neutral response + "already registered" / re-verify email; hourly opportunistic purge of expired sessions and tokens.                                                                                                                                                     |
| L6  | CSP / image pins                                                           | `object-src 'none'`, `frame-src 'none'` added; nonce-based `script-src` documented as the open follow-up (needs the header minted in `src/proxy.ts`). Node images pinned to 22.23; the CI Postgres bump is listed below.                                                  |
| L7  | `.env.example` shipped a live `STUDIO_PLATFORM_HOST` placeholder           | Commented out and documented together with the new variables.                                                                                                                                                                                                             |

Open follow-ups from this pass:

- `.github/workflows/ci.yml`: change `image: postgres:16` to `image: postgres:17` so CI runs the same major as `compose.yaml`. Not included here because the Arena GitHub connection lacks the `workflows` permission needed to push workflow edits; it is a one-line change for a maintainer.
- Nonce-based `script-src` (drop `'unsafe-inline'`) by emitting the CSP header per request from `src/proxy.ts`.
- `npm audit` still reports the dev-only `drizzle-kit → @esbuild-kit → esbuild ≤ 0.24.2` advisory (GHSA-67mh-4wv8-2f99); it does not ship in the production image. Clears when drizzle-kit drops `@esbuild-kit`.
- Existing custom domains become `pending` after migration 0010 and need one TXT verification each; tell merchants before the deploy.

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
