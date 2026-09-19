# Valmont Agent

Valmont Agent is a private, web-based software assistant with reopenable conversations and explicit human approval before coding and again before a pull request. It can discuss general questions or read-only repository context, hand a reviewed conversation into a coding task, generate a context-grounded plan, apply model-generated file changes in a restricted workspace, run approved validations, and create a reviewed `valmont/*` pull request.

> **Safety boundary:** Valmont never merges, deploys, force-pushes, changes repository settings, or writes to protected/base branches. A pull request requires an explicit final approval.

## What works

- GitHub OAuth with encrypted, short-lived, `HttpOnly`, `SameSite=Lax` session data
- Authorized repository listing plus explicit GitHub repository creation with user-selected name and private/public visibility
- Bounded source-tree retrieval, archive download, branch/commit, and pull-request operations
- Actual model-generated file creation, modification, and deletion inside a generated task workspace
- Approved dependency/test/lint/type-check/build command execution with real output and diffs
- Persisted approval-first task state machine and visible audit timeline
- **Chat with Valmont** for normal, reopenable conversations, with optional read-only repository/branch context and an explicit conversation-to-task handoff
- **Ideas page** — the owner's private notebook (`/ideas`) for ideas and future plans, with status (idea / planned / building / done / dropped), Now/Soon/Later priority, client-side search, and the same CSRF, rate-limit, zod-validation and secret-redaction guards as memories. Ideas are scoped to the signed-in account and are never sent to the chat model or included in any model prompt; they are stored in SQLite (or PostgreSQL when `DATABASE_URL` is set) and ride along in the complete backup file.
- Repository retrieval with sensitive/generated/binary path exclusions, bounded files, lexical/symbol search, and secret redaction
- Provider-neutral `ModelProvider` supporting chat, structured output, tools, streaming, usage, and normalized errors
- OpenAI-compatible server adapter configured only through server environment variables
- Restricted local `WorkspaceProvider` with traversal/symlink defenses, exact command allowlist, timeouts, output limits, and process-group termination
- Landing, dashboard, repositories, task creation/detail/result, diff, validation, tools, approvals, and settings interfaces
- Typed Drizzle ORM schema, migration, and session-scoped PostgreSQL task store for every required workflow entity
- CSRF double-submit protection, same-origin checks, basic rate limiting, security headers, input validation, and audit events

## Brand

The interface uses the Valmont Web visual identity from [valmontweb.com](https://valmontweb.com):

| Token        | Hex       | Usage                                     |
| ------------ | --------- | ----------------------------------------- |
| Navy blue    | `#0A1F44` | Strong backgrounds, sidebar, headings     |
| Orange       | `#E8822B` | Primary actions and approval boundaries   |
| Warm ivory   | `#ECE9DE` | Page backgrounds and inverse text         |
| Valmont blue | `#14446C` | Secondary navigation and informational UI |
| Slate        | `#606678` | Supporting body text                      |

Palette tokens live in the `@theme` block of `src/app/globals.css` and are consumed as Tailwind utilities (`bg-navy`, `text-copper`, `bg-ivory-50`, `text-brandblue`, `text-slate`). The `copper` token carries the orange ramp. Green and red are reserved exclusively for passed/failed validation status. Focus rings are orange and visible on every interactive element.

Primary buttons use navy text on orange (5.93:1) because white on this orange measures only 3.51:1 and fails WCAG AA. Orange on navy is 5.93:1, ivory on navy is 13.37:1.

### Live only

Valmont has a single runtime. It always runs against real GitHub repositories, your configured model provider, and real workspace execution. There is no demo mode, no sample-data flag, and no fixture fallback anywhere in the product, so the application can never invent repository data, plans, patches, validation output, diffs, branches, or pull-request results:

- unauthenticated visitors are redirected to connect GitHub instead of being given a fictional workspace;
- `createModelProvider()` throws when `MODEL_API_KEY` is missing rather than substituting a deterministic planner;
- the API returns `401` with a clear "connect GitHub" message, and the UI renders a connect prompt listing the exact server variables still required;
- `/api/health` reports `degraded` with a `missingConfiguration` list until every required variable is set.

Missing credentials fail loudly and name the unset variable. Nothing is fabricated to fill the gap.

The included local workspace adapter makes the complete flow usable on a trusted self-hosted machine. Before allowing untrusted repositories or users, replace it with an ephemeral container or external sandbox `WorkspaceProvider` as described below.

## Quick start

Requirements: Node.js 22.13+ (the container images pin 22.23) and npm. Chat memory uses the built-in local SQLite driver; no hosted database or paid vector service is required.

```bash
npm install
cp .env.example .env.local # set GitHub, model, and session values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Configure `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `MODEL_API_KEY` first — without them Valmont reports what is missing rather than showing sample data. Then connect GitHub, create or choose a repository, submit a task against a selected branch, approve the grounded plan, inspect the actual validation output and diff, and give final approval to create the real pull request.

## Environment configuration

Valmont requires `SESSION_SECRET`, the GitHub OAuth pair, and `MODEL_API_KEY`. Never prefix model or GitHub secrets with `NEXT_PUBLIC_`.

| Variable                     | Purpose                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | PostgreSQL connection URL                                                                      |
| `CHAT_STORE_PATH`            | Legacy JSON chat-store input for migration (default `.data/chat-store.json`)                   |
| `CHAT_SQLITE_PATH`           | SQLite chat-store destination; defaults to a sibling `.sqlite` path next to `CHAT_STORE_PATH`  |
| `SESSION_SECRET`             | 32+ random characters for AES-GCM session encryption; short or placeholder values are refused  |
| `APP_URL`                    | Public origin, e.g. `http://localhost:3000`; every emailed link and payment return URL uses it |
| `TRUST_PROXY`                | `true` only behind a proxy that rewrites `X-Forwarded-For` (per-client rate limits)            |
| `VALMONT_WORKSPACE_PROVIDER` | `local` (default, restricted process) or `docker` (one throwaway container per task)           |
| `GITHUB_CLIENT_ID`           | GitHub OAuth App client ID                                                                     |
| `GITHUB_CLIENT_SECRET`       | GitHub OAuth App secret                                                                        |
| `MODEL_BASE_URL`             | OpenAI-compatible `/v1` base URL                                                               |
| `MODEL_API_KEY`              | Server-only model API key                                                                      |
| `MODEL_NAME`                 | Provider model identifier                                                                      |
| `MODEL_BACKUP_API_KEY`       | Optional backup model key; when set, a transient primary failure retries once on the backup    |
| `MODEL_BACKUP_BASE_URL`      | Optional backup `/v1` base URL; defaults to `MODEL_BASE_URL`                                   |
| `MODEL_BACKUP_NAME`          | Optional backup model identifier; defaults to `MODEL_NAME`                                     |
| `VALMONT_COMMAND_TIMEOUT_MS` | Per-command validation timeout (default 180000)                                                |

See `.env.example` for placeholders and the optional Studio, payments,
custom-domain and notification variables.

`GET /api/health` is the readiness probe (503 until the required settings and
dependencies are usable); `GET /api/health?probe=live` is the liveness probe
used by the container `HEALTHCHECK`.

### GitHub OAuth

1. Create a GitHub OAuth App under **Settings → Developer settings → OAuth Apps**.
2. Set the homepage to `APP_URL` and callback URL to `${APP_URL}/api/auth/github/callback`.
3. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a strong `SESSION_SECRET`.
4. Restart the app and choose **Connect GitHub**.

The MVP requests `read:user user:email repo`. GitHub's OAuth `repo` scope is needed to create repositories and to read or create branches/PRs in private repositories; GitHub OAuth does not expose a narrower private-repository write scope. For a multi-tenant production deployment, prefer a GitHub App with carefully reviewed repository administration/creation behavior and repository-selected Contents/Pull requests permissions. Valmont's adapter additionally allows content writes only to `valmont/*` branches and has no merge method.

### GitHub repository creation

The protected **Repositories** page has an explicit creation form for a user-selected name, optional description, and `private` or `public` visibility. **Private is the client and server default.** Submitting the form calls GitHub's authenticated-user repository endpoint and initializes a README so a default branch exists immediately. The resulting repository can then be selected for a chat or approval-gated coding task.

Creation is a direct user action, not a model tool: it requires an authenticated session, same-origin CSRF token, validated bounded input, and a stricter per-IP rate limit. Valmont exposes no repository deletion or settings-editing operation. A public selection is visually explicit and is never inferred from a prompt.

### Model provider

Configure an OpenAI-compatible endpoint:

```env
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=replace-me
MODEL_NAME=gpt-4.1-mini
```

Credentials are read only in server modules. Add another provider by implementing `ModelProvider` in `src/lib/models`; the workflow does not need to change.

A free or busy primary provider gets a spare brain: set `MODEL_BACKUP_API_KEY`
(and `MODEL_BACKUP_BASE_URL` / `MODEL_BACKUP_NAME` when the backup is a
different host, e.g. Groq or OpenRouter) and a request the primary refuses with
429/5xx, a network error or a timeout is retried once on the backup. The log
names the reason (`[models] primary failed (…), using backup`). A 400/401/403
never fails over — a wrong key or a rejected request still fails loudly. Leave
the backup key unset and every call goes to the primary exactly as before.

### Chat with Valmont

Chat sessions are separate from coding tasks. A session can be general, or it can use bounded, redacted, read-only context from one authorized GitHub repository and branch. The chat model receives no workspace or GitHub write tools and cannot modify files. When a conversation is ready for implementation, **Create coding task** copies a redacted, editable transcript into the existing task form; the normal plan and final approval gates still apply.

Reopenable sessions, messages, FTS retrieval data, and long-term memories are stored locally in SQLite. `CHAT_STORE_PATH` remains the backward-compatible legacy JSON input (default `.data/chat-store.json`), while `CHAT_SQLITE_PATH` selects the SQLite destination. When `CHAT_SQLITE_PATH` is omitted, Valmont derives a distinct sibling destination by replacing the legacy path extension with `.sqlite` (for example `.data/chat-store.json` becomes `.data/chat-store.sqlite`), so a configured persistent legacy directory remains in use. Before migration, Valmont creates `<legacy path>.pre-sqlite-backup`, migrates transactionally, and records completion only with the migrated rows. Never point both variables at the same file; the legacy JSON source is never opened as SQLite or overwritten. High-confidence secret patterns are redacted before messages are sent or persisted, but chat history is still sensitive local data: do not paste credentials, restrict filesystem access, and include the store in an intentional backup/deletion policy. Retrieved repository files are not persisted in the chat store.

### PostgreSQL — controlled migrations, never automatic

```bash
createdb valmont
npm run db:verify:local   # no DB — validates full journal, SHA-256, ordering
npm run db:migrate        # requires DATABASE_URL — advisory lock, applies missing in journal order, re-verifies
npm run db:verify         # read-only — verifies ledger membership against journal
```

Migrations live in `src/db/migrations` with journal `meta/_journal.json`. The system validates the **complete** journal, not just the latest timestamp:

- structure (`version`/`dialect`), sequential `idx` 0..n-1 matching array position, unique `tag`/`idx`, numeric `when`, `breakpoints` boolean, SQL file existence, SHA-256 hash.
- journal order is authoritative — never timestamp ordering (regression: `0007_studio_domains` when `1787573273009` < `0006_studio_settings` when `1787616000000` but idx 7 > 6).
- ledger verification checks exact membership by hash + `created_at` against `drizzle.__drizzle_migrations`, failing closed on missing/altered/duplicate/unexpected rows.

**Fresh Docker volume:** `compose.yaml` mounts `0000_lazy_leopardon.sql` (base schema, lexical first) and `0001_bootstrap_ledger.sql` (inserts ledger row with hash `3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249` timestamp `1786700718887` derived from source). This makes a new volume report `migrations.status: complete` for the historic base only.

**Existing volume without compatible ledger:** `/api/health` returns degraded 503 with `dependencies.migrations: { status: "incomplete", expected, applied }` until an operator runs `db:migrate`.

Valmont never runs prod migrations automatically. CI provides a throwaway PostgreSQL 16 service and runs `db:migrate` → `db:verify` → `npm test` → `build`.

When `DATABASE_URL` is set, Valmont selects the session-scoped PostgreSQL task store and persists tasks, events, approvals, tool executions, validations, diffs, and pull-request records. Without it, tasks fall back to an ignored local JSON store so the application remains runnable during setup.

### Customer email delivery (Resend)

Customer account emails (verification, password reset, order notifications) require **both** `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM` — validated together, all-or-nothing:

- both unset → `not_configured` → dev returns clearly local-only one-time links, prod fails closed 503.
- one set / blank / malformed / CR-LF / angle-bracket injection → `invalid` → 503.
- both valid (plain `noreply@example.com` or `Valmont <noreply@example.com>`) → `configured`.

Delivery uses `fetch` with portable `AbortController` + 10s timeout (timer cleared in `finally`), provider failures normalized to typed 502 `CustomerEmailDeliveryError` with generic message (no bodies/keys leak). Config check runs **before** account lookup for anti-enumeration; `forgot-password`/`resend-verification` suppress only 502 after lookup, preserving neutral `ok:true`. See `src/lib/resend-config.ts` and `src/lib/customer-email.ts`.

### Strict typed API errors

`src/lib/api-errors.ts` defines explicit `ApiError` subclasses with intentional statuses: 400 `BadRequestError`, 401 `UnauthorizedError`/`NotConnectedError`, 403 `ForbiddenError`, 404 `NotFoundError`/`ChatNotFoundError`/`TaskNotFoundError`/etc, 409 `ConflictError`/`DraftConflictError`/`ImportInProgressError`/`OrderTransitionError`/`OnlinePaymentUnavailableError`, 413 `PayloadTooLargeError`, 429 `RateLimitError`, 502 `CustomerEmailDeliveryError`/`GitHubApiError`, 503 `CustomerEmailConfigurationError`/`WeakSessionSecretError`.

`safeApiError` in `src/lib/api.ts` trusts **only** `ApiError` instances. Zod errors → generic 400, JSON syntax → generic 400, arbitrary `Error("Task not found")`, plain objects with `status`, driver/network errors → opaque 500. No message-text heuristics. Tests preserve a single shared `ApiError` identity (no `vi.resetModules` with partial mocks).

## Scripts

```bash
npm run format         # format source and docs
npm run format:check   # verify formatting
npm run lint           # ESLint (Next.js core web vitals + TypeScript)
npm run typecheck      # strict TypeScript
npm test               # Vitest suite
npm run db:verify:local # validate journal + hashes, no DB
npm run db:migrate     # controlled migrate: advisory lock, apply missing in journal order, re-verify
npm run db:verify      # read-only ledger verification
npm run build          # production Next.js build
npm run validate       # all checks above plus build
npm run db:generate    # generate a migration from Drizzle schema
```

## Project map

- `src/app` — Next.js App Router pages and protected APIs
- `src/components` — application UI and approval controls
- `src/lib/workflow.ts` — persisted workflow orchestration and approval gates
- `src/lib/models` — provider-neutral model contract and adapters
- `src/lib/github` — GitHub contract and API adapter
- `src/lib/retrieval.ts` — repository filtering and lexical retrieval
- `src/lib/workspace.ts` — sandbox contract and restricted development adapter
- `src/db` — Drizzle schema and SQL migrations
- `docs/ARCHITECTURE.md` — design and extension points
- `docs/SECURITY.md` — threat model and controls
- `docs/PRODUCTION.md` — Docker deployment and production hardening checklist

## Important production note

The local workspace adapter is **not** represented as a secure production sandbox. Its checks reduce accidental host access, but repository scripts execute as a host process. Use an ephemeral container or external code sandbox with an unprivileged user, read-only base image, CPU/memory/PID limits, network egress controls, short TTL, and no host mounts. See the threat model for details.

## Website Studio Phase 1

The Website Studio collects everything needed to plan a website. It does **not**
build, deploy, or run one. Everything below describes what Phase 1 actually
does today.

### What Phase 1 can do

- **A four-step wizard** — website type (with an online-shop sub-type), package,
  look and layout, then business details. Steps can be revisited in any order.
- **Drafts you own** — create, edit, reopen, and delete. A draft is tied to your
  GitHub identity; nobody else can read or change it.
- **Autosave** — changes save automatically a moment after you stop typing.
  Saves are queued one after another, never overlapping, so a fast typist cannot
  race their own edits. The header always shows the current state ("All changes
  saved", "Saving…", "Not saved yet", or the reason a save failed).
- **Nothing is lost when you change your mind** — switching website type,
  package, theme, or layout keeps every business detail you have already
  entered. If a chosen layout does not suit a new website type, the closest
  suitable layout is selected instead.
- **Brief completeness** — a percentage plus a plain-language list of what is
  still needed. This measures how complete the _plan_ is, not whether a website
  is ready to launch.
- **A safe preview** — shows only what you typed. Missing details appear as
  "Not provided yet". Text is never treated as HTML, and only `https` links that
  pass a safety check become clickable.
- **Two people editing at once is handled honestly** — if the draft changed
  elsewhere while you were typing, Valmont refetches, reapplies your pending
  edit when the two changes do not overlap, and otherwise shows both options and
  asks which to keep. Neither person's work is silently discarded.
- **Products as well as services** — simple names and optional categories only.
- **Ghana-friendly defaults** — Ghana, GHS/GH₵, `Africa/Accra`, automatic +233
  phone formatting, the sixteen Ghana regions, WhatsApp, and service or delivery
  areas.
- **Backups** — download everything (chats, memories, website drafts, and ideas) as one
  JSON file, and restore it later.

### What Phase 1 cannot do

- No file or logo uploads. `assetStatus` is only a marker; there is no upload
  control and no arbitrary asset URL is ever stored.
- **No payments of any kind.** Payment preferences recorded in a draft are
  labelled future-planning information. Mobile money, Paystack, Valmont Pay,
  cards, checkout, and delivery calculation are **not connected and do not
  work.**
- No product catalogue, prices, stock, cart, or orders.
- No repository generation, no sandboxed build, and no deployment.
- No admin roles or team sharing. (Stage 6b later added a shop-owner login
  with per-person permission boxes for data-bundles shops — see _Shop admin_
  below; the agency side still has no roles.)

Phases 2–6 (uploads and object storage, repository generation, sandboxed
builds, preview deployments, roles, e-commerce and payments) are deliberately
**not implemented.**

### Data Bundles website type

A **Data Bundles & Airtime Reseller** website type sells MTN, Telecel and AirtelTigo data bundles with instant delivery. Bundles are normal catalogue products with a structured `bundle: { network, dataMb, validity }` field (1 GB = 1024 MB, stored as whole MB so 0.5 GB → 512 MB). The wizard shows a dedicated **Bundles you sell** table with network, size (MB/GB display-only switch), price and validity, plus a _Load starter price list_ that merges 18 Ghana bundles (6 per network) by stable id. Readiness v2 requires at least one priced bundle with metadata and no missing fields. The public shop at `/s/[id]` renders network tabs, size+validity, Ghana-mobile-only checkout (02x/05x, 030 landline refused, normalized to 0xxxxxxxxx, single `validateGhanaMobile` source), and shows a network-mismatch warning only. Category switching strips bundle metadata when leaving data-bundles and enriches priced items when entering, keeping the brief valid so autosave never freezes. Stage 3 adds a required **recipient phone** (`recipient_phone` column, one number per order, every bundle in the basket goes to that number) plus an optional buyer contact number, and enforces **Valmont Pay only, no delivery** for bundle shops (superRefine + wizard + checkout route). The recipient must be a Ghana mobile; the buyer's own contact may be from any country, because many bundle buyers are in the diaspora paying for family in Ghana. Stale bundle configs saved before the online-only rule (cash on delivery, or delivery switched on) are repaired on read so autosave cannot freeze. The guest order-confirmation page prints no phone number except a masked recipient line (`024 ••• 0001`); full numbers appear only on the owner's Studio order page and the customer-account order page. Stage 4 adds automatic delivery: after payment, a delivery engine creates one tracked top-up per purchased bundle unit — driven by a **simulator** for test-mode orders (test numbers ending `0000` rehearse failure, `9999` rehearse a slow 60-second delivery), and live-money bundle checkout refused with 409 until the shop has a real delivery connection.

### Bundle delivery with TechChief (Stage 5)

Stage 5 connects the real thing: each data-bundles website stores **its own** TechChief API key, so every merchant sends top-ups from their own wallet and no key is shared between shops. The owner pastes the key in Studio → their website → **Bundle delivery**; Valmont checks the format (`TCHX-…`), calls TechChief's wallet endpoint, and stores the key **only** if the API is activated and the account is active — a rejected or unactivated key leaves nothing behind and never overwrites a working connection. The key is encrypted with `SESSION_SECRET` (the same AES-256-GCM envelope as payment settings), and only a nine-character prefix (`TCHX-9F8E`) is ever shown again: it is never logged, never returned by an API, never included in a backup export, and never handed to a client component. The card also shows the wallet balance, the cached TechChief price list, and any priced bundle TechChief cannot deliver (no network, no size, or a network/size they do not sell), so the owner finds that out before a customer pays.

Once a connection is `verified`, live-money bundle checkout is accepted and paid orders dispatch through TechChief; **test-mode orders never touch TechChief even when a key is saved** — they keep rehearsing against the simulator. Status comes back two ways: TechChief's webhook (`POST /api/bundle-delivery/techchief/webhook?integration=<uuid>`, hex HMAC-SHA256 in `X-TechChiefX-Signature` when the owner saves a signing secret, otherwise the reported status is confirmed against TechChief before it is believed) and the owner's **Check status now** button, which is throttled to one real poll per top-up per 10 minutes. TechChief allows 60 requests an hour per key: Valmont spends at most 50 on polls, balance checks and price-list syncs and always leaves the headroom for orders, so a customer's top-up is never refused for budget. When an order's outcome is genuinely unknown (a timeout, a 5xx), the top-up is marked failed with _"check your TechChief dashboard before retrying"_ — it is never resent automatically, because the send may already have landed. Merchants get an email when a delivery fails and a separate one when the wallet is too low to keep selling. Readiness v2 gained a `bundleDelivery` dependency for this: a data-bundles shop is not "ready for live sales" until its own connection is verified, while every other website type is unaffected.

### Commercial packages for bundle shops (Stage 6a)

Every data-bundles website is sold under exactly one **package**. The agency user picks it in Studio (step 2 of the wizard, "Which bundle package did the client buy?"); the shop owner can never change it, and the prices are labels only — the software never charges them. A brief without a package means **Auto-Dispatch Pro**, which is the exact feature set every bundle shop had before packages existed, so no existing website changes behaviour. Other website types ignore the package everywhere.

| id               | label             | price label         | switches on                                                                                                                                                                                             |
| ---------------- | ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starter`        | Starter Shop      | GH₵ 3,500 one-time  | shop + Valmont Pay checkout; **manual delivery** — the owner sends the data himself and every top-up row waits at "pending" until a human marks it (Stage 6c); the existing new-order alerts still fire |
| `auto_dispatch`  | Auto-Dispatch Pro | GH₵ 6,500 one-time  | + 1 supplier API (TechChief, Stage 5) auto-send; live order status page (existing confirmation page); one-tap bundle pause (Stage 6c)                                                                   |
| `command_center` | Command Center    | GH₵ 10,000 one-time | + second supplier API slot with backup (provider not chosen yet — a gap, no provider code); sales & margin dashboard (Stage 6d); agents & in-shop wallets (Stage 7)                                     |

The Care Plan (GH₵ 250/month) and the 40/40/20 payment schedule are agency processes — nothing to build. The single server-side gate is `planAllows(plan, feature)` in `src/lib/studio/plans.ts`; a feature outside the package answers 403 "Not included in your package."

**Starter in practice:** the checkout 409 "This shop cannot send bundles automatically yet…" no longer applies to Starter — a live Starter order is accepted with no TechChief key, because the owner is the delivery mechanism. Delivery rows are created per purchased unit exactly as usual but carry `provider = "manual"` and stay "pending"; the customer's confirmation line reads "The shop will send your bundle to 024 ••• 0001 by hand. Contact the shop if it does not arrive."; the Studio panel badge reads the package and manual rows read "To send by hand". Even a saved, verified TechChief key is never used while the package is Starter — switching the package back to Auto-Dispatch Pro restores it untouched.

### Shop admin — the owner's own login (Stage 6b)

Until Stage 6b the only person who could see a bundle shop's orders was the agency user in Studio. Stage 6b gives the **shop owner** (and the people they choose) their own sign-in at **`/manage/<website-id>`** — a third side of the product that is kept strictly apart from the other two:

| side             | who                        | signs in with                      | cookie                     | pages                |
| ---------------- | -------------------------- | ---------------------------------- | -------------------------- | -------------------- |
| Website Studio   | the agency user            | GitHub OAuth                       | `valmont_session`          | `/studio/*`          |
| Customer account | a buyer on one storefront  | email + password (per website)     | `valmont_customer_session` | `/account/*`         |
| **Shop admin**   | **the shop owner + staff** | **email + password (per website)** | **`valmont_shop_session`** | **`/manage/<id>/*`** |

The shop admin side has its own tables (`studio_shop_admins`, `studio_shop_admin_sessions`, `studio_shop_admin_tokens`), its own layout (the shop's name and package badge — no Studio navigation, no agency user names), and its own API under `/api/manage/<id>/*`. It never imports the agency session module; a test (`src/lib/shop-admin/boundary.test.ts`) fails if anyone ever does. The storefront does not link to it — the owner reaches it from the link the agency sends.

**How a shop gets its owner.** In Studio → the website → **Shop logins** (shown for every data-bundles package, under the Bundle delivery card), the agency user enters the owner's name and email and clicks _Create owner login_. Valmont creates an `invited` owner row and a one-time invite link (`/manage/<id>/accept-invite?token=…`, valid 24 hours, single use, stored as a SHA-256 hash). With `RESEND_API_KEY` set the link is emailed; without it the card shows the link **once** with _Send this link to the owner on WhatsApp_, and it is never shown again. The owner opens the link, sees their name and email, chooses a password (10–128 characters), and lands on their orders. The agency never sees or sets the owner's password; the same card can resend an invite, mint a password-reset link for an active owner, and disable or re-enable any of the shop's logins. Exactly one owner per shop.

**What the owner sees.** A read-only dashboard — the orders of **this website only**, newest first, with the same status filter tabs as Studio; each order shows the time (Africa/Accra), customer name, the recipient's phone number **in full** (the owner has to send the data there), every bundle line (`MTN 1GB × 2`), the total, the order status, and one delivery row per purchased unit with the same `deliveryStatusLabel` wording Studio uses plus the supplier reference. Nothing on this side can change an order yet — fulfilment actions are Stage 6c. The owner never sees the TechChief key beyond its nine-character prefix, the webhook secret, the agency's payment settings, the package selector, or any other shop.

**Team.** The owner (only) opens **Team**, invites up to **10 logins per website**, and ticks permission boxes per person — `orders.fulfil`, `bundles.manage`, `supplier.manage`, `reports.view` — there are no fixed roles below "owner". Everyone with a login can see orders; the boxes decide what else they will be able to do once those actions exist, and the owner can change them any time. Disabling a login signs that person out everywhere immediately. The owner's own row cannot be disabled or demoted from inside the shop — only the agency can do that from Studio. Team invites go by email when it is configured; otherwise the page says so and the agency passes the link on from Studio — the shop side never displays a raw invite link.

**Passwords and sessions.** Passwords use the same scrypt helper as customer accounts, and a sign-in failure — unknown email, wrong password, disabled or not-yet-accepted login, email that belongs to another shop — always answers the identical `401 "Email or password is incorrect."` after a dummy-hash comparison, so timing and wording reveal nothing. Sessions live 30 days in an httpOnly, `SameSite=Lax`, `Secure`-in-production cookie whose value is stored only as a hash; a session minted for shop A is simply "not signed in" on shop B (`404` from B's API). Forgot-password always answers `200 "If that email exists, we sent a link."`; reset links last one hour and a successful reset signs out every other session. Rate limits: 10 login attempts per email and 30 per IP per minute, 5 forgot-password requests per email per hour, 10 invites/resends per website per hour. The three shop-admin tables are **not** part of the backup export and an import ignores them, so a restored deployment never carries someone else's password hashes.

### Shop actions (Stage 6c)

The 6b dashboard was read-only; 6c adds the writes, and every one of them is behind the owner's permission boxes (the owner always passes; a member without the box gets `403 "Your login does not include this action. Ask the shop owner."`) and behind the package where the price sheet says so. All four routes share the same preamble — CSRF, the shop session, the permission check, an hourly rate limit keyed on the website, a 16 KB bounded body — and pin the order (or the draft) to that website before anything is read or written, so a sibling website's order is a 404.

**Mark by hand** (needs `orders.fulfil`; 60/h per website). On the order page, a pending manual row — a Starter Shop's "To send by hand" — gets **Mark delivered** and **Mark failed** (with an optional 200-character note that becomes the row's error text, defaulting to "Marked as not sent by the shop."). A failed row of any provider gets **Mark delivered** too, for the case where the shop settles a top-up out of band. The allowed transitions and their refusals:

| row                       | Mark delivered                                                        | Mark failed                                    |
| ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| pending, manual (Starter) | ✅ delivered (`delivered_at` set, error cleared)                      | ✅ failed (note as `last_error`)               |
| failed, any provider      | ✅ delivered (provider, reference and attempts untouched)             | 409 "This top-up is already marked as failed." |
| delivered                 | 409 "This top-up is already delivered." — delivered is terminal       | same                                           |
| processing                | 409 "This top-up is being sent automatically - use Check status."     | same                                           |
| pending, automatic        | 409 "This top-up is queued for automatic sending - use Check status." | same                                           |

Each mark is ONE atomic `UPDATE` with those guards inside the `WHERE` clause (the same pattern that makes a concurrent webhook dispatch and page-load recheck unable to double-send), so two people clicking at once move the row exactly once. No merchant alert fires — the shop did it itself.

**Retry failed top-ups** and **Check status now** (both `orders.fulfil`; one shared bucket of 40/h per website, because both can spend the website's TechChief allowance). They call the same engine functions the Studio owner's buttons call, after the order pin. On a Starter shop Retry is refused with 409 "This shop sends bundles by hand - mark the top-up delivered instead." and the engine is never asked — and the Studio order page for a Starter shop shows the sentence "This shop sends bundles by hand - the shop owner marks delivery in the shop admin." instead of its own Retry button. The shop order page never runs a recheck on load; the buttons are the only way to spend allowance from the shop side.

**Bundles** (needs `bundles.manage`; 60/h per website; the page appears in the nav and the route exists only for data-bundles websites). At `/manage/<id>/bundles` each bundle row has a price input with **Save** and a **Pause / Resume** toggle. Prices go through the same `priceAmount` validation as the wizard (positive, at most two decimals, ≤ 1,000,000) and are allowed on every package; **pause** additionally needs the `bundle_pause` package feature — Auto-Dispatch Pro and Command Center — so a Starter shop sees the toggle replaced by "Pause is part of Auto-Dispatch Pro." and the API answers the standard "Not included in your package." The write changes only that one item, re-validates the whole brief, and saves with the draft's optimistic concurrency (revision + 1). A paused bundle disappears from the storefront's bundle list (the plus button cannot add it) and checkout refuses it with `400 "This bundle is currently unavailable."` before any order row exists; orders already placed keep their snapshot prices. The wizard cannot unpause a bundle by accident: an autosave that omits the `paused` key inherits the stored item's value.

**What still never crosses to the shop side.** The agency owner id (delivery rows leave the API through a projection that drops it), the TechChief key beyond its prefix, the webhook secret, payment settings, `adminEmail`, other shops, agency user names — every 6c response is a projection of something the 6b page already showed.

### Supplier and sales & margin (Stage 6d)

Stage 6d finishes the shop side with the two Command Center surfaces and records what every top-up actually costs. Each delivered top-up now stores the price TechChief charged for **that one send** (`api_price`, migration `0016`) — captured from the `dev_order.php` answer at the successful send, overwritten when a retry really sends again, never invented for simulator, manual or pre-0016 rows, and never cleared by a failure. The Studio order view is unchanged; the number exists for the shop's report.

**Supplier page** (`/manage/<id>/supplier`, needs the `supplier.manage` box and a package with the supplier page — Auto-Dispatch Pro and Command Center; Starter and any other website type are 404s). The page never calls TechChief: it renders the last stored state — wallet balance, connection status, the key prefix (always the stored 9 characters rendered as `TCHX-AB12•••`), last-checked time, requests used this hour of 60, the number of bundles TechChief can deliver — plus a **Refresh balance** button and the TechChief top-up link. A low wallet shows the low-balance banner; an error status shows the error and "Ask your agency to save a new key in Studio."; a shop with no key yet sees the not-connected card. Command Center shops (only) also see the **"Second supplier (backup)"** card. Refreshing calls the same library probe Studio's "Check balance" uses — exactly one slot of the website's 60/hour TechChief allowance — after two shop-side ceilings: at most **6 refreshes per hour per website** and never within **10 minutes** of the last check (a too-soon refusal costs nothing). Refusals and successes alike answer with only the projection above: no webhook URL, no webhook-secret flag, no agency owner id, no key material beyond the prefix.

**Sales & margin report** (`/manage/<id>/reports`, needs the `reports.view` box on **Command Center** only). One website's own numbers for today / 7 days / 30 days (default) / this month: paid **live** orders (refunded and cancelled orders excluded everywhere; paid test orders counted but never in money), the money those orders collected, what the supplier charged for the delivered top-ups whose cost is known, and the margin left over — plus the same money columns per network and per bundle (top 10 by delivered top-ups), and delivered / failed / in-flight counts. A row's price is its checkout-time snapshot; rows without a recorded cost (sent by hand, by the simulator, or before migration `0016`) never pretend to a cost. The report is **aggregates only**: no customer names, no phone numbers, no order ids on the page.

### Agent logins and in-shop wallets (Stage 7a)

Command Center data-bundles shops can give resellers their own agent login. Owners add agents at `/manage/<SHOP-ID>/agents`; agents sign in at `/a/<SHOP-ID>`. The agent portal shows the shop's bundle catalogue at one shop-wide agent discount, the current wallet balance and the newest 100 ledger entries. It has no buying button in Stage 7a: buying from the wallet is Stage 7b, and online wallet top-ups through Valmont Pay are Stage 7c.

Only the shop owner can add or disable agents, set the shop-wide discount, or add and remove wallet credit. Members cannot unlock wallet actions with a permission box, and `wallets.topup` remains reserved. Every manual wallet change is one signed, append-only ledger entry in integer pesewas; a deduction is rejected atomically when it would make the balance negative. Agent passwords, session values and invite/reset tokens are hashed, and agent sessions last 30 days. The five agent tables are excluded from backups. Agent invites need `RESEND_API_KEY`; when email is not configured the owner page explains that Valmont must enable it and never displays the raw invite link.

### Agent wallet checkout (Stage 7b)

Stage 7b lets an agent **buy from the wallet**. Each bundle row on the agent home page keeps its discounted price and gains an order panel: the agent types the customer's number, sees what the wallet will be charged and what it looks like afterwards, and confirms. `POST /api/a/<SHOP-ID>/orders` recomputes the price on the server (catalogue price minus the shop's agent discount — the browser never sends a price), checks the wallet the same way a deduction is checked, debits it and writes exactly one signed `purchase` ledger entry alongside the balance change in ONE transaction, creates the order as `agent_wallet`, marks it paid through the single channel that sets `paidAt`, and runs the same delivery engine as the public checkout (simulator in test mode, the shop's own TechChief key once connected). Insufficient balance, stopped sales, paused bundles, unknown items, basket caps and the live-delivery guard all refuse **before** any order row exists.

The agent gets an **Orders** nav link: `/a/<SHOP-ID>/orders` lists only their own orders, each order page shows the status, the recipient number they typed, the balance after the purchase and live delivery progress — no retry or mark buttons, those stay with the owner. The owner sees an **Agent** badge on wallet-paid order rows in `/manage/<SHOP-ID>`, "Paid from agent wallet - Reseller" on the order, and — owner-only — **Refund to wallet**, which credits the purchase amount back once per order (one `refund` entry, enforced by a partial unique index) and moves the order to Refunded. Refund while paid or delivered; every ledger row for an order links to it from both statement pages.

`agent_wallet` is NOT in `PAYMENT_METHODS`: it is not selectable in Studio → Payments, is refused by the public checkout like any unknown method, and public orders never carry `agent_id`. The order's access code stays server-side — the agent (and the API response) never sees it; unsigned guest pages already show only statuses.

### Brand Kit (Stage B)

A client who has **no brand yet** can get one in minutes. In the Studio wizard, right under the business-name field, the agency opens the collapsed **"No brand yet? Create one"** card and answers four questions — what the business sells, which town it is based in, how the brand should feel (trusted / friendly / premium / young), and up to three words the name must include. One **Suggest a brand** click (a single model call, two only when the safety filter below eats too many names) returns five name ideas with a one-line meaning and a tagline each, plus three colour palettes sized to the existing theme registry.

Every name idea shows its two hand-check domains (`slug.com`, `slug.com.gh`, letters and digits only) and three links the agency opens by hand — **Check Instagram / TikTok / WHOIS**. Stage B deliberately makes no external availability calls: checking is a human decision. Each palette card previews a header bar, a button and body text in the suggested colours; the server has already corrected any unreadable text/surface pair to WCAG AA (4.5), so an unreadable combination can never be offered. A simple **text logo** (name only, badge with initials beside the name, or badge stacked above the name) renders as deterministic SVG, and its PNG is saved into `brief.assets.logo` through exactly the same validation and budget as a hand upload. A one-page **brand sheet** (1200×1600 PNG: logo, name, tagline, the three colours with hex codes, the font name, "Made with Valmont - valmontweb.com") downloads on demand and is never stored.

**Suggestions only — the agency decides.** Nothing reaches the brief until a "Use this name" / "Use this palette" / "Save as logo" button is clicked, and each of those writes through one apply route with the wizard's own optimistic concurrency: exactly `businessName`, `tagline`, `selectedTheme` and `preferredColours` change, nothing else. Names copying protected brands (the mobile networks, Ghana Card, GhanaPost, and a small list of others) are filtered out on the server before they are ever shown — but that filter is not a trademark search, so the agency should always check a name (the links are right there) before putting it to a client.

**The package rule** mirrors the price sheet: Command Center bundle shops include the Brand Kit; Starter and Auto-Dispatch Pro bundle shops get it as a one-time **GH₵ 600 add-on**, which the agency ticks on the brief ("Client paid the Brand Kit add-on" — a label only, never charged by the software); a bundle shop on a smaller package without the tick gets 403 "Not included in your package." everywhere the tools would run. Every other website type (restaurants, salons, schools, churches, …) is always allowed — the Brand Kit is for all categories, the gate only exists because bundle shops are sold under packages.

### Where drafts are stored

- **Without `DATABASE_URL`** — SQLite, in **exactly the same file as Chat**. One
  shared path resolver (`src/lib/sqlite-path.ts`) is used by both, so there is
  never a second database file and a legacy JSON store is never opened as
  SQLite.
- **With `DATABASE_URL`** — PostgreSQL, in the `studio_drafts` table.

### Not losing an edit (optimistic concurrency)

Every draft carries a `revision` number. A save sends the revision it was based
on, and the server applies it as a single atomic statement:

```sql
UPDATE studio_drafts
   SET brief = $1, revision = revision + 1, updated_at = now()
 WHERE id = $2 AND owner_id = $3 AND revision = $4
RETURNING ...
```

If no row comes back the save is rejected with `409 Conflict` — never a
misleading `200`. With two people saving the same revision at the same moment,
exactly one succeeds. A draft that does not exist and a draft belonging to
somebody else both return the same generic `404`, so the API never reveals
whether an ID exists.

### Backups

- `GET /api/backup/export` downloads a version 2 backup:
  `{ backupVersion: 2, exportedAt, chat: {...}, studio: {...}, customers: {...}, domains: {...} }`.
  Custom domains are exported without their verification tokens; on import
  they are re-attached as `pending` with a fresh token and must be verified
  again, and a hostname already claimed on the target machine is skipped and
  counted.
- `POST /api/backup/import` accepts a version 2 backup **and** a legacy
  version 1 chat-only file. An unknown version is rejected _before anything is
  written_.
- Owner IDs inside the file are never trusted. Everything is reassigned to the
  signed-in account.
- A draft ID that already exists is imported as a separate copy under a new ID
  rather than overwriting your work.
- The whole import is all-or-nothing. On SQLite, chat, memories and drafts
  share one database handle and one transaction, and the export reads both
  halves inside one read transaction so a backup file is a consistent snapshot.
  With `DATABASE_URL` set, chat stays in SQLite while drafts go to PostgreSQL;
  those two engines are **not** one atomic snapshot on export. A durable
  cross-store coordinator takes an owner-level **lease** (token, generation,
  heartbeat expiry) so a second import for the same account is refused with
  `409` before either store changes, then records the staged payload and a
  pre-import snapshot. A live lease is never treated as a crash. After a
  real crash the lease expires and the next import or startup claims recovery
  with a compare-and-swap. SQLite-only complete imports take the same lease.
  PostgreSQL Studio writes are additionally fenced inside PostgreSQL itself: a
  durable per-owner fence row (identity only, never exported) must pass a
  conditional check as the final statement of every Studio import/restore
  transaction, so a transaction whose lease was replaced mid-flight can never
  commit late writes over a finished recovery.
  Any failure — or a process killed mid-import — rolls both stores back to
  their exact previous state. Success is reported only after both halves committed; a rolled-back
  import is reported as a plain failure, never a partial success. After success
  or a successful rollback the journal keeps only non-sensitive metadata (id,
  owner, status, timestamps, counts) — the payload and snapshot are logically
  deleted. That is not a guarantee the bytes have been wiped from SQLite pages
  or filesystem backups. An unresolved rollback failure keeps the snapshot and
  the lock until recovery finishes.
- The older `/api/memories/export` and `/api/memories/import` endpoints keep
  their version 1 behaviour unchanged.

### Request size limits

Request bodies are read as a stream and counted byte by byte, stopping as soon
as the limit is passed and parsing only afterwards. This holds even when
`Content-Length` is missing, wrong, or the body is chunked.

| Endpoint                                    | Limit   |
| ------------------------------------------- | ------- |
| Draft create and update                     | 1 MB    |
| Backup import                               | 25 MB   |
| Payment webhook (raw body, HMAC-verified)   | 50 KB   |
| Tasks                                       | 64 KB   |
| Chat messages                               | 32 KB   |
| Chats, memories, repositories, task actions | 4–16 KB |

Errors never echo back what you submitted, so business details and private
values stay out of messages and logs.

### Testing

```bash
npm test                # unit and integration tests (Vitest)
npm run test:e2e        # browser tests (Playwright, Chromium)
```

The browser tests need a session secret and a browser:

```bash
npx playwright install --with-deps chromium
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm run test:e2e
```

They build and start a real production server on port 3200 (override with
`E2E_PORT`) against a throwaway SQLite database under `.e2e-data`. Your real
`.data` files are never touched. Sign-in uses a genuine encrypted session
cookie created with the same `SESSION_SECRET` the server was started with —
**there is no test-only authentication bypass in application code.**

The PostgreSQL draft tests only run when `STUDIO_TEST_DATABASE_URL` points at a
throwaway database; otherwise they are reported as skipped, never as passed. CI
provides a real PostgreSQL 16 service so they always run there. Playwright
schedules 11 tests across 2 projects (22 scheduled tests). Do not treat a
past test count as a permanent fact — use the latest CI run on the pull request.

The production Docker image does **not** install browser binaries.

### Stage 7a: agent logins and wallets

Command Center shops can invite up to 50 agents at `/a/SHOP-ID`. Agents have
an independent login, see bundles at the shop-wide agent discount, and see a
wallet balance and append-only statement. The shop owner is the only person
who can add or remove wallet credit; each change is one ledger entry. Stage 7a
does not include buying or online wallet top-ups.

Stage 7b adds buying from the wallet: `POST /api/a/SHOP-ID/orders`, the
agent **Orders** pages, per-order purchase/refund ledger entries (single
transaction, once-per-order enforced by partial unique indexes), and the
owner-only **Refund to wallet** on an agent order. See the Stage 7b threat
notes in `docs/SECURITY.md` and migration `0018_agent_orders.sql` in
`docs/PRODUCTION.md`.
