import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-[800px] px-4 py-8 sm:px-7">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-slate transition-colors hover:text-copper-700"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" /> Settings
      </Link>

      <div className="card mt-6 overflow-hidden">
        <div className="bg-navy px-6 py-7 sm:px-8">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-copper" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-[-0.03em] text-ivory">
              Security model
            </h1>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ivory/70">
            Valmont is designed around explicit approval, bounded retrieval,
            restricted tools, and an immutable audit trail. It never merges or
            deploys.
          </p>
        </div>

        <div className="space-y-6 p-6 sm:p-8">
          {[
            [
              "Live-only runtime",
              "Valmont has no demo or sample-data mode. It never substitutes fictional repository data, plans, patches, validations, or pull-request results: when a credential is missing it names the unset variable and asks you to connect GitHub or configure a model provider.",
            ],
            [
              "Trust boundaries",
              "The browser never receives model or GitHub credentials. OAuth session data is encrypted with AES-256-GCM and stored in a short-lived, HttpOnly, SameSite cookie.",
            ],
            [
              "Repository retrieval",
              "Generated output, dependencies, binaries, .env files, credentials, private keys, and known sensitive paths are excluded. Retrieved text is bounded and redacted.",
            ],
            [
              "Execution",
              "The local adapter blocks traversal and symlink escapes, uses an exact command allowlist, kills timed-out process groups, and limits output. It is for development only—not a production sandbox.",
            ],
            [
              "Approval and GitHub writes",
              "Plan approval authorizes workspace edits and listed validations only. A separate final approval is required before creation of a valmont/* branch and pull request. Protected branches, force pushes, merges, settings, and deployment are outside the tool surface.",
            ],
            [
              "Production requirements",
              "Use ephemeral containers or an external sandbox with network egress controls, PostgreSQL, a distributed rate limiter, managed encryption keys, centralized audit logs, and regular credential rotation.",
            ],
          ].map(([title, copy]) => (
            <section
              key={title}
              className="border-l-2 border-copper-300 pl-4 sm:pl-5"
            >
              <h2 className="text-sm font-bold text-navy">{title}</h2>
              <p className="mt-2 text-[12px] leading-6 text-slate">{copy}</p>
            </section>
          ))}

          <p className="border-t border-line pt-6 text-[11px] text-slate">
            For the detailed threat model and assumptions, see{" "}
            <code className="rounded bg-ivory-100 px-1 py-0.5 text-navy">
              docs/SECURITY.md
            </code>{" "}
            in the repository.
          </p>
        </div>
      </div>
    </div>
  );
}
