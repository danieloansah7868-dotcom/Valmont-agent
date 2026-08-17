# Deferred items — agreed with the owner, to be tackled next session

These are parked deliberately. Nothing here is urgent, and nothing here is broken
for users. Recorded so they are not forgotten.

Owner note: PR #10 was merged intentionally by the owner. It was not a mistake and
nothing about it needs to be reverted. The items below are follow-up housekeeping
caused by that merge, plus one pre-existing task.

---

## 1. Fix the formatting on `main`

**Status:** not done, awaiting owner's go-ahead.

`main` (`df702ff`) currently fails the `format:check` step. Three files are affected:

- `src/app/page.tsx`
- `src/components/app-nav.tsx`
- `src/components/app-shell.tsx`

**Nothing is broken for users.** Verified on a clean checkout of `df702ff`, with no
other branch involved:

| Check | Result |
| --- | --- |
| `lint` | pass |
| `typecheck` | pass |
| `test` | pass (86) |
| `build` | pass |
| `format:check` | **fail** |

The fix is one command run on `main`:

```
npx prettier --write .
```

The change is cosmetic. Verified by stripping all whitespace and comparing the
files character by character, the only non-whitespace differences are:

- `src/app/page.tsx` — one redundant pair of brackets `(` `)` removed from a
  nested ternary that Prettier re-wrapped across lines
- `src/components/app-shell.tsx` — one trailing comma removed
- `src/components/app-nav.tsx` — pure line wrapping, no character change at all

None of these alter behaviour.

**Why it matters:** until it is fixed, every future pull request shows a red X on
its `validate` check, even when the pull request itself is perfect. That makes it
hard to tell a real failure from inherited noise.

**Why it was not done automatically:** it touches `main`, and the standing rule is
no changes without explicit permission.

---

## 2. Require checks to pass before a pull request can be merged

**Status:** not done, for discussion.

PR #10 was merged while its `validate` check was failing. That was the owner's
deliberate decision and is entirely allowed.

Worth deciding whether GitHub should *block* merging when checks fail, as a
guard against merging a genuine failure by accident on some future day. This is a
branch-protection setting on `main` and is reversible at any time.

This is a policy decision for the owner, not a code change. Options range from
"leave as is" to "block merges until checks pass, with an override for the owner".

---

## 3. Activate the Phase 1 CI workflow

**Status:** blocked on a human. Cannot be done by an agent.

`.github/ci-workflow-phase1.yml` needs to be moved to `.github/workflows/ci.yml`.

Attempted and rejected by GitHub with:

> refusing to allow a GitHub App to create or update workflow
> `.github/workflows/ci.yml` without `workflows` permission

This is a hard platform security rule: automation is not permitted to edit the
files that control what automation runs. There is no workaround from an agent
session.

A human maintainer must run, on the `arena/01a00fc5-valmont-agent` branch:

```
git mv .github/ci-workflow-phase1.yml .github/workflows/ci.yml
git commit -m "Activate the Phase 1 CI workflow"
git push
```

**What activating it adds:** a throwaway PostgreSQL 16 service so the 10
PostgreSQL tests run in CI, plus Chromium so the 16 Playwright browser tests run.
Until then CI runs neither.

Note: the 10 PostgreSQL tests have since been run manually against a real
PostgreSQL 18.4 server and all 10 pass. The 16 browser tests have still never
been executed anywhere.

---

## 4. Re-run PR #9's checks against the current `main`

**Status:** not done. Should happen after item 1.

PR #9's green checks were computed against the **old** `main` (`6131e97`), before
PR #10 landed. GitHub has not yet recalculated them, so the green ticks on the PR
page are stale — they do not reflect the current `main`.

This was verified locally instead: PR #9 merged with the current `main` passes
lint, typecheck, all 236 tests (including the 10 real PostgreSQL ones) and the
production build. The only failure in that merged state is the formatting problem
inherited from `main`, described in item 1.

Once item 1 is fixed, PR #9 should be refreshed so GitHub recomputes its checks
against the corrected `main` and the ticks mean something again.

---

## Unchanged status

**Website Studio Phase 1 has not been merged or deployed.** PR #9 still requires an
independent review from a separate Arena session before any merge decision.
