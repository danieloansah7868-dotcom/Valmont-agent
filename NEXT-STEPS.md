# Follow-up items — status updated by the final-corrections session

Owner note: PR #10 was merged intentionally by the owner. It was not a mistake and
nothing about it needs to be reverted. The items below were follow-up housekeeping
caused by that merge; several have since been resolved by the Website Studio
final-corrections PR (which supersedes PR #9 and must not be merged before an
independent review).

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

- `npm ci`, `format:check`, `lint`, `typecheck`
- Drizzle migrations against a throwaway **PostgreSQL 16 service**, then
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

**Status:** not done. Deferred deliberately; raised in independent review of PR #9.

`safeApiError` ends in a fallback that infers the HTTP status from the text of
the error message: `"Task not found"` becomes 404, anything containing `"CSRF"`
becomes 403, `"Rate limit"` becomes 429, everything else 400. Rewording any of
those strings silently changes the status code a client sees.

This is the same anti-pattern the Studio work removed when it gave every error a
numeric `status` field, and no Studio route reaches the fallback. It survives
because pre-existing chat, task and repository routes still throw bare `Error`s
that depend on it. Fixing it means giving those routes typed errors, which
changes behaviour outside Website Studio and belongs in its own PR with its own
tests.

**Do not delete the fallback before those routes are converted** — every one of
them would start returning 400.

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
