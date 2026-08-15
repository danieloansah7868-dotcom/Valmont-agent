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

Requirements: Node.js 22.5+ and npm. Chat memory uses the built-in local SQLite driver; no hosted database or paid vector service is required.

```bash
npm install
cp .env.example .env.local # set GitHub, model, and session values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Configure `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `MODEL_API_KEY` first — without them Valmont reports what is missing rather than showing sample data. Then connect GitHub, create or choose a repository, submit a task against a selected branch, approve the grounded plan, inspect the actual validation output and diff, and give final approval to create the real pull request.

## Environment configuration

Valmont requires `SESSION_SECRET`, the GitHub OAuth pair, and `MODEL_API_KEY`. Never prefix model or GitHub secrets with `NEXT_PUBLIC_`.

| Variable                     | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`               | PostgreSQL connection URL                                       |
| `CHAT_STORE_PATH`            | Optional local chat JSON path (default `.data/chat-store.json`) |
| `SESSION_SECRET`             | 32+ random bytes for AES-GCM OAuth session encryption           |
| `APP_URL`                    | Public origin, e.g. `http://localhost:3000`                     |
| `GITHUB_CLIENT_ID`           | GitHub OAuth App client ID                                      |
| `GITHUB_CLIENT_SECRET`       | GitHub OAuth App secret                                         |
| `MODEL_BASE_URL`             | OpenAI-compatible `/v1` base URL                                |
| `MODEL_API_KEY`              | Server-only model API key                                       |
| `MODEL_NAME`                 | Provider model identifier                                       |
| `VALMONT_COMMAND_TIMEOUT_MS` | Per-command validation timeout (default 180000)                 |

See `.env.example` for placeholders.

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

### Chat with Valmont

Chat sessions are separate from coding tasks. A session can be general, or it can use bounded, redacted, read-only context from one authorized GitHub repository and branch. The chat model receives no workspace or GitHub write tools and cannot modify files. When a conversation is ready for implementation, **Create coding task** copies a redacted, editable transcript into the existing task form; the normal plan and final approval gates still apply.

Reopenable sessions and messages are stored locally in ignored `.data/chat-store.json` by default. Set `CHAT_STORE_PATH` only if a different server-local path is needed. High-confidence secret patterns are redacted before messages are sent or persisted, but chat history is still sensitive local data: do not paste credentials, restrict filesystem access, and include the store in an intentional backup/deletion policy. Retrieved repository files are not persisted in the chat store.

### PostgreSQL

```bash
createdb valmont
npm run db:migrate
```

Migrations are in `src/db/migrations`. When `DATABASE_URL` is set, Valmont automatically selects the session-scoped PostgreSQL task store and persists tasks, events, approvals, tool executions, validations, diffs, and pull-request records. Without it, tasks fall back to an ignored local JSON store so the application remains runnable during setup.

## Scripts

```bash
npm run format         # format source and docs
npm run format:check   # verify formatting
npm run lint           # ESLint (Next.js core web vitals + TypeScript)
npm run typecheck      # strict TypeScript
npm test               # Vitest suite
npm run build          # production Next.js build
npm run validate       # all checks above plus build
npm run db:generate    # generate a migration from Drizzle schema
npm run db:migrate     # apply PostgreSQL migrations
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
