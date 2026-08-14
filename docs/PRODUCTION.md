# Production deployment

## Supported deployment shape

Valmont's real workflow performs filesystem work and may run for several minutes. Deploy it to a persistent Node.js service or container host—not a short-timeout edge/serverless function. PostgreSQL is required for durable production state.

The included `Dockerfile` and `compose.yaml` provide a repeatable single-tenant deployment for trusted repositories. They run the web service as an unprivileged user, drop Linux capabilities, keep PostgreSQL separate, and persist `.data` workspaces.

```bash
cp .env.example .env
# Set APP_URL, POSTGRES_PASSWORD, SESSION_SECRET, GitHub, and model values.
docker compose up --build -d
curl https://your-domain.example/api/health
```

The compose migration mount initializes a new PostgreSQL volume. For an existing database, review and apply migrations manually with `npm run db:migrate` from a controlled release job. Valmont never runs production migrations from an agent task.

The compose port binds only to `127.0.0.1`. Put Caddy on the host in front of it:

```caddyfile
agent.valmontweb.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

After the DNS record points to the server, Caddy obtains and renews HTTPS automatically. Add Cloudflare Access or another identity-aware proxy in front of the subdomain when it must be private over the public internet.

## Required configuration

- `ENABLE_DEMO_MODE=false` (the default) so no fictional data can reach production users
- A public HTTPS `APP_URL`
- 32+ random bytes in `SESSION_SECRET`
- GitHub OAuth App callback `${APP_URL}/api/auth/github/callback`
- OpenAI-compatible model endpoint/key/name with structured JSON output support
- PostgreSQL with TLS and backups
- Reverse proxy with request-body limits, HTTPS, and execution-friendly timeouts

## Critical sandbox boundary

Dockerizing the Valmont web process is not the same as isolating each repository task. The bundled `RestrictedLocalWorkspaceProvider` is appropriate only for a private, single-tenant installation where every connected repository and user is trusted.

Before exposing Valmont to customers, organizations you do not control, or public sign-up, implement `WorkspaceProvider` using one ephemeral container or microVM per task. The task sandbox must have:

- no mount of the application container, Docker socket, host source, or cloud credentials;
- an unprivileged user, read-only base image, seccomp/AppArmor, and no added capabilities;
- CPU, memory, PID, disk, output, and wall-clock quotas;
- default-deny network and blocked cloud metadata;
- a task-specific writable volume destroyed on completion;
- narrowly proxied dependency access only when the approved plan includes installation;
- no GitHub/model/session credentials inside validation processes.

## Operations checklist

1. Replace OAuth with a repository-selected GitHub App when serving multiple tenants.
2. Move execution into a durable queue/worker before horizontal scaling.
3. Use managed session storage/KMS token encryption and distributed rate limiting.
4. Ship audit events to append-only centralized storage.
5. Add workspace TTL cleanup, storage quotas, alerts, and backup restoration tests.
6. Keep `/api/health` on an internal monitoring check.
7. Review failed validations and diffs; never bypass final approval.
8. Keep branch protection and mandatory GitHub reviews enabled.

Valmont intentionally has no merge or deployment method. Your existing reviewed CI/CD process should deploy only after a human merges the pull request in GitHub.
