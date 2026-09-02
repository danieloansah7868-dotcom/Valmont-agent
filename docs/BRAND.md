# Valmont Agent — Brand Identity

> **Nothing ships without you.**

|              |                                                    |
| ------------ | -------------------------------------------------- |
| Version      | 1.0 — September 2026                               |
| Owner        | Valmont                                             |
| Product      | Valmont Agent — private, approval-first software assistant |
| Token source | `src/app/globals.css` (`@theme` block)              |
| Asset source | `docs/brand/`                                      |

This document is the single source of truth for how Valmont Agent looks,
sounds, and behaves in the world. Where it overlaps the product, the
implementation tokens in `globals.css` win on exact values; this document
wins on intent and rules.

---

## 1. Brand core

### One-liner

**Valmont Agent is a private software assistant that plans, writes, and
validates code — and does none of it without your explicit approval.**

### Mission

Give teams the leverage of an always-available engineering collaborator
without surrendering control of the repository. Valmont does the careful
work; the human makes the calls.

### Positioning

Most coding agents sell autonomy — "let it run." Valmont Agent sells
**verified leverage**: every plan is grounded in your real repository,
every change is applied in a restricted workspace, every validation runs
against real output, and nothing becomes a pull request until a person
says so. There is no demo mode and no fabricated output anywhere in the
product. What you see is what ran.

This makes Valmont Agent the agent for repositories where the work
matters: payments, banking, data, infrastructure — the Valmont
portfolio's own territory.

### Brand architecture

Valmont is the house. Its ventures — payments, banking, data, web, AI,
gadgets, electrical services, advertising — share the Valmont palette and
the V mark. **Valmont Agent** is the house's software assistant.

- The **house lockup** (tile + `VALMONT`) names the portfolio.
- The **product lockup** (`VALMONT` in navy + `AGENT` in copper) names
  this product. Copper is the color of action and approval — the agent is
  the active element inside the calm house.
- Ventures never invent new hues. They may add one restrained accent only
  with brand-owner approval.

### Personality

| Trait        | What it means                                                    |
| ------------ | ---------------------------------------------------------------- |
| Deliberate   | Moves at the speed of proof, not the speed of hype               |
| Exact        | Names the branch, the file, the command, the variable            |
| Transparent  | Shows its work: plans, diffs, logs, timelines — always the real ones |
| Calm         | No exclamation marks, no urgency theater, no dark patterns       |
| Stewardly    | Treats the repository as someone else's property, because it is  |

### Values

1. **Consent before change.** Two explicit approvals — before code is
   written and before a pull request is created — are the product, not a
   friction to remove.
2. **Truth over theater.** Live only. Missing configuration fails loudly;
   nothing is ever fabricated to fill a gap.
3. **Precision as care.** Bounded retrieval, redacted secrets, restricted
   workspaces, exact command allowlists. Care is a feature you can audit.
4. **The human signs.** Valmont never merges, never deploys, never
   force-pushes, never touches protected branches.

---

## 2. Story & messaging

### Story

Every team knows the moment: a pull request appears, three hundred lines
in, from an "agent" that read half a README and guessed the rest. Valmont
Agent was built for the opposite moment — the one where you say *"show me
the plan first."* It reads your repository like an engineer, proposes a
grounded plan, waits for you to approve it, applies changes inside a
restricted workspace, runs the validations you allow, shows you the
untouched output, and then waits again — because the last word on
shipping belongs to a person. The copper line at the base of the V is
that waiting: the threshold where the machine stops and you decide.

### Tagline

**Primary:** `Nothing ships without you.`

Approved alternates (situational, never mixed in one piece):

- `The agent that asks first.`
- `Real plans. Real diffs. Your approval.`
- `Leverage, with the last word.`

### Messaging pillars

| Pillar            | Claim                                              | Proof                                            |
| ----------------- | -------------------------------------------------- | ------------------------------------------------ |
| Approval-first    | Nothing changes without explicit human consent      | Two-gate state machine, visible audit timeline    |
| Grounded          | Plans come from your actual repository, not guesses | Bounded retrieval, branch selection, citations to files |
| Verifiably live   | No demo mode, ever                                 | Real commands, real output, `degraded` health when unconfigured |
| Safe by design    | Hard boundaries, not promises                      | `valmont/*` branches only; no merge, no deploy, no settings writes |

---

## 3. Voice & tone

Valmont Agent speaks like a senior engineer briefing a trusted colleague:
precise, unhurried, honest about uncertainty.

### Principles

1. **Say the true thing.** If it didn't run, it doesn't get described as
   run. If configuration is missing, name the variable.
2. **Name the exact thing.** Branch names, file paths, command names,
   exit codes. "Some tests failed" is banned; "`npm test` exited 1 — 3
   failures in `src/pay/`" is the voice.
3. **Calm, not clever.** No puns, no hype verbs (*revolutionize,
   supercharge, unlock*), no exclamation marks.
4. **Approval is a feature.** Write about waiting as a strength:
   "paused for your approval," never "interrupted."
5. **No theater.** Never manufacture urgency, progress, or success.

### Say / don't say

| Situation        | ✅ Say                                            | 🚫 Don't say                                  |
| ---------------- | ------------------------------------------------- | --------------------------------------------- |
| Plan ready       | Plan ready for your review — 4 files, 2 commands.  | 🎉 Your amazing plan is ready!!!               |
| Approval gate    | Paused for your approval before writing code.      | Waiting on user input…                          |
| Failure          | `MODEL_API_KEY` is not set. Set it and retry.      | Something went wrong. Please try later.        |
| Success          | Pull request #42 created from `valmont/task-17`.   | All done! You're welcome!                       |
| Capability limit | I can't merge — merging is outside my boundaries.  | Sorry, I'm not allowed to do that :(            |

### Mechanics

- Sentence case for buttons and headings ("Create pull request", not
  "Create Pull Request").
- Present tense, active voice. "Valmont runs the command," not "The
  command will be run by Valmont."
- Numbers, branch names, paths, and commands in code style — always the
  real ones.
- Errors follow the pattern: **what failed → why → the exact next step.**
- Never blame the user; never apologize more than once.

---

## 4. Logo system

### Concept — the checkpoint V

The mark is a **V** whose foot is crossed by a copper band: the
**threshold**. Ivory letterform (the work) resting on copper (the
approval boundary) inside a navy field (the house). Every asset in the
system repeats this one idea: work stops at the copper line until a
human moves it.

### Assets

| File                              | Contents                                | Use                                        |
| --------------------------------- | --------------------------------------- | ------------------------------------------ |
| `docs/brand/valmont-tile.svg`     | Contained mark, navy tile               | App icon, favicon, avatar                  |
| `docs/brand/valmont-glyph.svg`    | Bare V glyph, navy — transparent        | Light/ivory surfaces, watermark            |
| `docs/brand/valmont-glyph-reverse.svg` | Bare V glyph, ivory — transparent  | Navy/blue surfaces, posters                |
| `docs/brand/valmont-lockup.svg`   | Tile + `VALMONT` wordmark, navy         | House communications on light surfaces     |
| `docs/brand/valmont-lockup-reverse.svg` | Tile (navy-800) + ivory wordmark   | Navy surfaces                              |
| `docs/brand/valmont-lockup-product.svg` | Tile + `VALMONT` navy + `AGENT` copper | Product naming; headers, docs, release notes |

The wordmark is **drawn geometry** (monoline, 5-unit stroke, 40-unit cap
height, rounded terminals) — not a font. Never retype it; always place
the SVG.

### Clear space & minimum sizes

- Clear space on all sides: **half the tile height** (H/2). Nothing —
  type, rules, other marks — enters it.
- Minimum widths: lockup **96 px** (print: 32 mm); product lockup
  **140 px** (print: 45 mm); tile/glyph **16 px**.
- Below 24 px, use the tile only, never the lockup.

### Color variants

| Variant                    | Field     | Letterform | Threshold |
| -------------------------- | --------- | ---------- | --------- |
| Primary (tile)             | Navy      | Ivory      | Copper    |
| Bare glyph on light        | —         | Navy       | Copper    |
| Bare glyph on navy/blue    | —         | Ivory      | Copper    |
| Monochrome print           | —         | Black/white | Same ink |

The threshold stays copper in every variant except single-ink printing.
It is never recolored navy, green, or any venture accent.

### Misuse — never

- Stretch, condense, rotate, or skew the mark or wordmark.
- Retype the wordmark in Inter or any other font.
- Recolor the letterform copper, or the threshold navy.
- Place the primary lockup on photography, patterns, or copper fields.
- Add shadows, outlines, bevels, or gradients.
- Change the tile's corner radius (14/64) or redraw the V.

---

## 5. Color

### Core palette

| Role          | Name         | Hex       | RGB           | Use                                        |
| ------------- | ------------ | --------- | ------------- | ------------------------------------------ |
| Foundation    | Navy         | `#0A1F44` | 10 31 68      | Strong surfaces, sidebar, headings, tile   |
| Action        | Copper       | `#E8822B` | 232 130 43    | Primary buttons, approval boundaries, focus |
| Warm ground   | Ivory        | `#ECE9DE` | 236 233 222   | Page backgrounds, inverse text             |
| Support       | Valmont blue | `#14446C` | 20 68 108     | Secondary navigation, informational UI     |
| Body text     | Slate        | `#606678` | 96 102 120    | Supporting copy, secondary text            |

**Distribution:** roughly 60% ivory/paper ground, 25% navy structure,
10% slate/blue support, 5% copper action. Copper is scarce on purpose —
scarcity is what makes the approval moment visible.

### Ramps (tokens in `globals.css`)

| Navy          | Copper         | Ivory         | Valmont blue   | Slate          |
| ------------- | -------------- | ------------- | -------------- | -------------- |
| `navy-900` `#06152F` | `copper-700` `#9E4E11` | `ivory-200` `#E3DFD1` | `brandblue-700` `#0F3455` | `slate-700` `#464B5B` |
| `navy-800` `#0D2953` | `copper-600` `#D26E1C` | `ivory-100` `#F2EFE6` | `brandblue-600` `#1B5688` | `slate-500` `#767C8D` |
| `navy-700` `#143467` | **`copper` `#E8822B`** | **`ivory` `#ECE9DE`** | **`brandblue` `#14446C`** | **`slate` `#606678`** |
| `navy-600` `#1D447F` | `copper-300` `#F3B77C` | `ivory-50` `#F8F6F0` | `brandblue-200` `#BCD2E3` | `slate-400` `#8B90A0` |
| **`navy` `#0A1F44`**   | `copper-100` `#FBE6D1` | —             | `brandblue-100` `#DBE7F0` | `slate-200` `#C9CCD5` |
| —             | `copper-50` `#FEF6EE`   | —             | `brandblue-50` `#EEF4F9`  | `slate-100` `#E5E7EC` |

Lines: `line` `#DCD8CB`, `line-strong` `#C5BFAE`, `line-cool`
`#DFE2E8`; paper `#FFFFFF`.

### Status colors — reserved

`pass` `#1F7A54` and `fail` `#B3392F` (plus soft tints `#E6F2EC`,
`#FBECEB`) mean exactly two things: a validation **passed** or
**failed**. They are never used decoratively, never in marketing, and
never as link or accent colors. `attention` `#A2661A` exists solely for
degraded/pending health states.

### Accessibility — measured contrast

| Pair                        | Ratio      | Verdict            |
| --------------------------- | ---------- | ------------------ |
| Navy on ivory               | 13.37 : 1  | AAA                |
| Ivory on navy               | 13.37 : 1  | AAA                |
| Navy on copper (buttons)    | 5.93 : 1   | AA — **required**  |
| Copper on navy              | 5.93 : 1   | AA                 |
| White on copper             | < 4.5 : 1  | **Fails — banned** |
| Ivory on Valmont blue       | 8.33 : 1   | AAA                |
| Slate on ivory-50           | 5.30 : 1   | AA body text       |
| Slate-700 on ivory-50       | 8.04 : 1   | AAA                |

Rules:

- Primary buttons are **navy text on copper**, never white on copper.
- Copper text appears only on navy or navy-900 (6.63 : 1), never on
  white or ivory.
- Focus rings are copper and visible on every interactive element.
- Body text below 18 px uses navy or slate-700, not slate-500.

---

## 6. Typography

### Families

| Role            | Family                                   | Notes                                     |
| --------------- | ---------------------------------------- | ----------------------------------------- |
| UI & display    | **Inter** (`Inter`, Avenir Next, Segoe UI, Roboto, Helvetica, Arial) | 650 for emphasis — the Valmont weight    |
| Code & telemetry| `JetBrains Mono`, `SF Mono`, `Menlo`, `Consolas`, monospace | Diffs, commands, output, branch names — always |

Inter is the product voice; the drawn wordmark is the logo. They are not
interchangeable.

### Scale

| Style          | Size / line     | Weight / tracking         | Use                          |
| -------------- | --------------- | ------------------------- | ---------------------------- |
| Display        | 56–72 / 1.05    | 650, −1%                  | Landing hero                 |
| H1             | 40 / 1.15       | 650, −0.5%                | Page titles                  |
| H2             | 28 / 1.25       | 650                       | Section heads                |
| H3             | 20 / 1.35       | 650                       | Card titles                  |
| Body L         | 18 / 1.6        | 400                       | Landing intro                |
| Body           | 15–16 / 1.6     | 400                       | Default copy                 |
| Label          | 14 / 1.4        | 650                       | Buttons, tabs                |
| Micro          | 13 / 1.4        | 500                       | Meta, helpers, timestamps    |
| Mono body      | 13 / 1.6        | 400                       | Diffs, logs, commands        |

Rules: sentence case everywhere; tabular numerals (`font-variant-numeric:
tabular-nums`) for IDs, counts, timings; no italics in UI; never fake
Inter weights with transforms.

---

## 7. Iconography & UI expression

- **Icons:** geometric, 1.5 px stroke at 24 px, rounded joins, matching
  the wordmark's monoline terminals. Drawn in navy or slate; status icons
  may use pass/fail colors only where a validation state exists.
- **Approval boundaries:** every gate (approve plan, approve pull
  request) is expressed with copper — button, rule, or ring. A user
  should be able to find every decision point by scanning for copper.
- **Focus:** 2 px copper ring, 2 px offset, on every interactive element.
- **Motion:** 150–200 ms ease-out for enters/exits; no bounce, no
  parallax, no motion that implies work being done faster than it is.
- **Elevation:** one soft shadow token (`--shadow-brand: 0 18px 48px
  rgb(9 21 52 / 0.12)`); elevation is subtle, like paper on cloth.
- **Surfaces:** ivory-50 ground, paper cards, navy chrome. Chat is a
  viewport workspace — the transcript owns scrolling.

---

## 8. Imagery

**Direction: engineered calm.** Flat, editorial, matte. Geometry carries
the meaning; negative space carries the confidence. The palette is
locked — navy, ivory, copper, slate, and nothing else. No stock photos of
hoodies and holograms, no glowing brains, no circuit-board clichés.

Reference assets (in `docs/brand/`):

| Asset                    | Role                                                |
| ------------------------ | --------------------------------------------------- |
| `poster.png`             | Campaign poster — the V at architectural scale      |
| `pattern.png`            | Chevron/threshold repeat for wraps and endpapers    |
| `application.png`        | Stationery direction — cards, letterhead, seal      |
| `approval-moment.png`    | Illustration style — the approval moment, abstract  |

Photography, when needed, follows `application.png`: overhead studio
light, linen and paper textures, real objects, deep shadow discipline —
and only the brand palette.

---

## 9. Applications

- **Product UI** — tokens come from `globals.css`; this document explains
  why they are what they are.
- **Pull requests** — always from `valmont/*` branches; PR copy uses the
  voice rules: what changed, what ran, what needs approval.
- **Docs & README** — ivory ground, navy headings, copper only for
  warnings that gate action.
- **Social/avatar** — the tile, never the lockup, at small sizes.
- **Email** — navy header band with reverse lockup, ivory body, one
  copper action per email.

---

## 10. Governance

- Exact values live in code: `@theme` in `src/app/globals.css`. Logo
  geometry lives in `docs/brand/*.svg` and nowhere else.
- Changes to palette, mark, or voice require brand-owner review and a
  version bump in this file's header.
- If a situation isn't covered here, decide by the test at the top of the
  document: *does it ship without you?* If the answer is yes, it isn't
  Valmont.
