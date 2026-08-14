import Link from "next/link";
import {
  CheckCircle2,
  CircleAlert,
  Database,
  Github,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { getSessionUser, githubConfigured } from "@/lib/auth";
import { createModelProvider } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getSessionUser();
  const model = createModelProvider();
  const githubReady = githubConfigured();
  const databaseReady = Boolean(process.env.DATABASE_URL);
  return (
    <div className="mx-auto max-w-[940px] px-4 py-7 sm:px-7 sm:py-9">
      <div>
        <div className="flex items-center gap-2">
          <p className="text-[12px] font-bold tracking-[0.08em] text-[#6c7b74] uppercase">
            Workspace configuration
          </p>
          {user.demo && <DemoBadge compact />}
        </div>
        <h1 className="mt-1.5 text-[29px] font-bold tracking-[-0.035em]">
          Settings & integrations
        </h1>
        <p className="mt-2 text-sm text-[#6b7872]">
          Provider credentials are read from server environment variables and
          never sent to the browser.
        </p>
      </div>

      <section className="card mt-7 overflow-hidden">
        <div className="border-b border-[#e2e8e4] px-5 py-4 sm:px-6">
          <h2 className="text-sm font-bold">Integration status</h2>
          <p className="mt-1 text-[11px] text-[#7b8781]">
            Restart the server after changing environment configuration.
          </p>
        </div>
        <div className="divide-y divide-[#e6ebe8]">
          <Integration
            icon={Github}
            title="GitHub OAuth"
            description={
              githubReady
                ? user.demo
                  ? "OAuth app configured; sign in to authorize repositories."
                  : `Connected as @${user.login}`
                : "Not configured. Demo repository data is active."
            }
            ready={githubReady && !user.demo}
            action={
              <Link
                href="/api/auth/github"
                className="btn-secondary min-h-8 text-[11px]"
              >
                {githubReady
                  ? user.demo
                    ? "Connect GitHub"
                    : "Reconnect"
                  : "Setup guide"}
              </Link>
            }
          />
          <Integration
            icon={KeyRound}
            title="Model provider"
            description={
              model.demo
                ? "No API key configured. Deterministic demo planner is active."
                : `${model.id} · ${model.model} · credentials loaded server-side`
            }
            ready={!model.demo}
          />
          <Integration
            icon={Database}
            title="PostgreSQL"
            description={
              databaseReady
                ? "DATABASE_URL is configured. Run migrations before production use."
                : "Not configured. Demo tasks persist to a local ignored data file."
            }
            ready={databaseReady}
          />
          <Integration
            icon={Server}
            title="Workspace sandbox"
            description="Restricted local adapter available for development. Production container provider required."
            ready={false}
            warning
          />
        </div>
      </section>

      <section className="mt-6 grid gap-5 sm:grid-cols-2">
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <LockKeyhole className="size-4 text-[#376c56]" />
            <h2 className="text-[13px] font-bold">Required server variables</h2>
          </div>
          <div className="mt-4 space-y-2">
            {[
              ["SESSION_SECRET", Boolean(process.env.SESSION_SECRET)],
              ["GITHUB_CLIENT_ID", Boolean(process.env.GITHUB_CLIENT_ID)],
              [
                "GITHUB_CLIENT_SECRET",
                Boolean(process.env.GITHUB_CLIENT_SECRET),
              ],
              ["MODEL_API_KEY", Boolean(process.env.MODEL_API_KEY)],
              ["DATABASE_URL", databaseReady],
            ].map(([name, set]) => (
              <div
                key={String(name)}
                className="flex items-center justify-between rounded-lg bg-[#f5f7f5] px-3 py-2"
              >
                <code className="text-[10px] font-semibold text-[#4d5f56]">
                  {String(name)}
                </code>
                <span
                  className={`text-[9px] font-bold ${set ? "text-[#2b7655]" : "text-[#8b9691]"}`}
                >
                  {set ? "SET" : "NOT SET"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[10px] leading-4 text-[#838e88]">
            Values are never displayed. Configure them in{" "}
            <code>.env.local</code> using <code>.env.example</code>.
          </p>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-[#376c56]" />
            <h2 className="text-[13px] font-bold">Enforced boundaries</h2>
          </div>
          <ul className="mt-4 space-y-3 text-[11px] text-[#627168]">
            {[
              "Plan approval before any code change",
              "Final approval before branch or pull request",
              "No protected-branch writes or force pushes",
              "No merge, deployment, settings, or migrations",
              "Secret redaction in logs and model context",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[#347557]" />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-5 flex gap-3 text-[10px] font-bold">
            <Link
              href="/docs/security"
              className="text-[#27684f] hover:underline"
            >
              Threat model
            </Link>
            <a
              href="https://github.com"
              className="text-[#27684f] hover:underline"
            >
              GitHub permissions
            </a>
          </div>
        </div>
      </section>

      <div className="mt-6 rounded-xl border border-[#e5d1a4] bg-[#fff9eb] p-4">
        <div className="flex gap-3">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-[#9b661f]" />
          <div>
            <p className="text-[11px] font-bold text-[#74501c]">
              Local execution is not a production sandbox
            </p>
            <p className="mt-1 text-[10px] leading-5 text-[#806b4c]">
              The included adapter validates paths, blocks symlink escapes, and
              allowlists commands, but a host process is not a complete security
              boundary. Production installations must use short-lived containers
              or an external sandbox with network and filesystem isolation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Integration({
  icon: Icon,
  title,
  description,
  ready,
  warning = false,
  action,
}: {
  icon: typeof Github;
  title: string;
  description: string;
  ready: boolean;
  warning?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-4 sm:px-6">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#edf2ef] text-[#4d685b]">
        <Icon className="size-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-[12px] font-bold">{title}</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[8px] font-bold ${ready ? "bg-[#e5f4eb] text-[#297052]" : warning ? "bg-[#fff1d6] text-[#92611f]" : "bg-[#eef1ef] text-[#77827d]"}`}
          >
            {ready ? "CONNECTED" : warning ? "DEV ONLY" : "DEMO"}
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-4 text-[#7d8983]">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
