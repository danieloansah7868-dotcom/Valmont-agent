import Link from "next/link";
import {
  CheckCircle2,
  CircleAlert,
  Database,
  Github,
  KeyRound,
  LockKeyhole,
  Radio,
  Server,
  ShieldCheck,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { PageHeading } from "@/components/states";
import { githubConfigured, requireSessionUser } from "@/lib/auth";
import { demoModeEnabled, missingLiveRequirements } from "@/lib/config";
import { tryCreateModelProvider } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireSessionUser();
  const model = tryCreateModelProvider();
  const modelReady = Boolean(model && !model.demo);
  const githubReady = githubConfigured();
  const databaseReady = Boolean(process.env.DATABASE_URL);
  const demoMode = demoModeEnabled();
  const missing = missingLiveRequirements();

  return (
    <div className="mx-auto max-w-[940px] px-4 py-7 sm:px-7 sm:py-9">
      <PageHeading
        eyebrow="Workspace configuration"
        title="Settings & integrations"
        description="Provider credentials are read from server environment variables and never sent to the browser."
      />

      {/* Runtime mode is the headline setting now that live mode is the default. */}
      <section
        className={`mt-7 overflow-hidden rounded-xl border ${
          demoMode ? "border-copper-300 bg-copper-50" : "border-line bg-white"
        }`}
      >
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex gap-3">
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                demoMode
                  ? "bg-copper-600 text-white"
                  : "bg-navy text-copper-300"
              }`}
            >
              <Radio className="size-[17px]" aria-hidden="true" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-navy">Runtime mode</h2>
                {demoMode ? (
                  <DemoBadge compact />
                ) : (
                  <span className="rounded-full bg-pass-soft px-2 py-0.5 text-[9px] font-bold text-pass-strong ring-1 ring-inset ring-pass/30">
                    LIVE
                  </span>
                )}
              </div>
              <p className="mt-1.5 max-w-xl text-[11px] leading-5 text-slate">
                {demoMode ? (
                  <>
                    <code>ENABLE_DEMO_MODE=true</code> is set. Repository
                    listings, plans, patches, validations and pull-request
                    results may be deterministic sample data. Set it to{" "}
                    <code>false</code> for normal production use.
                  </>
                ) : (
                  <>
                    Valmont is running against real GitHub repositories, your
                    configured model provider, and real workspace execution. No
                    fictional demo data is produced.
                  </>
                )}
              </p>
            </div>
          </div>
          <code className="shrink-0 rounded-md bg-ivory-100 px-2.5 py-1.5 text-[10px] font-bold text-navy ring-1 ring-inset ring-line">
            ENABLE_DEMO_MODE={String(demoMode)}
          </code>
        </div>
      </section>

      {!demoMode && missing.length > 0 && (
        <div className="mt-4 rounded-xl border border-copper-300 bg-copper-50 p-4">
          <div className="flex gap-3">
            <CircleAlert
              className="mt-0.5 size-4 shrink-0 text-copper-700"
              aria-hidden="true"
            />
            <div>
              <p className="text-[11px] font-bold text-copper-700">
                Live mode is missing required configuration
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {missing.map((name) => (
                  <li
                    key={name}
                    className="rounded-md bg-white px-2 py-1 text-[10px] font-bold text-slate-700 ring-1 ring-inset ring-copper-300"
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <section className="card mt-6 overflow-hidden">
        <div className="border-b border-line px-5 py-4 sm:px-6">
          <h2 className="text-sm font-bold text-navy">Integration status</h2>
          <p className="mt-1 text-[11px] text-slate">
            Restart the server after changing environment configuration.
          </p>
        </div>
        <div className="divide-y divide-line">
          <Integration
            icon={Github}
            title="GitHub OAuth"
            description={
              githubReady
                ? user.demo
                  ? "OAuth app configured; sign in to authorize repositories."
                  : `Connected as @${user.login}`
                : "Not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET."
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
              modelReady && model
                ? `${model.id} · ${model.model} · credentials loaded server-side`
                : demoMode
                  ? "No API key configured. The deterministic demo planner is active."
                  : "MODEL_API_KEY is not set. Tasks cannot generate plans or patches."
            }
            ready={modelReady}
          />
          <Integration
            icon={Database}
            title="PostgreSQL"
            description={
              databaseReady
                ? "DATABASE_URL is configured. Run migrations before production use."
                : "Not configured. Tasks persist to a local ignored data file instead."
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
            <LockKeyhole className="size-4 text-copper" aria-hidden="true" />
            <h2 className="text-[13px] font-bold text-navy">
              Required server variables
            </h2>
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
                className="flex items-center justify-between rounded-lg bg-ivory-50 px-3 py-2"
              >
                <code className="text-[10px] font-semibold text-navy">
                  {String(name)}
                </code>
                <span
                  className={`text-[9px] font-bold ${set ? "text-pass" : "text-slate-400"}`}
                >
                  {set ? "SET" : "NOT SET"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[10px] leading-4 text-slate">
            Values are never displayed. Configure them in{" "}
            <code>.env.local</code> using <code>.env.example</code>.
          </p>
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-copper" aria-hidden="true" />
            <h2 className="text-[13px] font-bold text-navy">
              Enforced boundaries
            </h2>
          </div>
          <ul className="mt-4 space-y-3 text-[11px] text-slate">
            {[
              "Plan approval before any code change",
              "Final approval before branch or pull request",
              "No protected-branch writes or force pushes",
              "No merge, deployment, settings, or migrations",
              "Secret redaction in logs and model context",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2">
                <CheckCircle2
                  className="mt-0.5 size-3.5 shrink-0 text-copper"
                  aria-hidden="true"
                />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-5 flex gap-4 text-[10px]">
            <Link href="/docs/security" className="link-brand">
              Threat model
            </Link>
            <a
              href="https://github.com/settings/developers"
              target="_blank"
              rel="noreferrer"
              className="link-brand"
            >
              GitHub permissions
            </a>
          </div>
        </div>
      </section>

      <div className="mt-6 rounded-xl border border-copper-300 bg-copper-50 p-4">
        <div className="flex gap-3">
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-copper-700"
            aria-hidden="true"
          />
          <div>
            <p className="text-[11px] font-bold text-copper-700">
              Local execution is not a production sandbox
            </p>
            <p className="mt-1 text-[10px] leading-5 text-slate-700">
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
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brandblue-50 text-brandblue">
        <Icon className="size-[17px]" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[12px] font-bold text-navy">{title}</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[8px] font-bold ring-1 ring-inset ${
              ready
                ? "bg-pass-soft text-pass-strong ring-pass/30"
                : warning
                  ? "bg-copper-50 text-copper-700 ring-copper-300"
                  : "bg-ivory-100 text-slate-700 ring-line"
            }`}
          >
            {ready ? "CONNECTED" : warning ? "DEV ONLY" : "NOT CONFIGURED"}
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-4 text-slate">{description}</p>
      </div>
      {action}
    </div>
  );
}
