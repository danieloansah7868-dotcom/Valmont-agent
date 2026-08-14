import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-[800px] px-4 py-8 sm:px-7">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-[#27674f]"
      >
        <ArrowLeft className="size-3.5" /> Settings
      </Link>
      <div className="card mt-6 p-6 sm:p-8">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-[#2b7154]" />
          <h1 className="text-2xl font-bold tracking-[-0.03em]">
            Security model
          </h1>
        </div>
        <p className="mt-4 text-sm leading-6 text-[#66756d]">
          Valmont is designed around explicit approval, bounded retrieval,
          restricted tools, and an immutable audit trail. It never merges or
          deploys.
        </p>
        <div className="mt-7 space-y-6">
          {[
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
            <section key={title}>
              <h2 className="text-sm font-bold">{title}</h2>
              <p className="mt-2 text-[12px] leading-6 text-[#6d7973]">
                {copy}
              </p>
            </section>
          ))}
        </div>
        <p className="mt-8 text-[11px] text-[#849089]">
          For the detailed threat model and assumptions, see{" "}
          <code>docs/SECURITY.md</code> in the repository.
        </p>
      </div>
    </div>
  );
}
