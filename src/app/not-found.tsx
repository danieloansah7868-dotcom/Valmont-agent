import Link from "next/link";
import { FileQuestion } from "lucide-react";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ivory-50 p-6">
      <div className="card max-w-md p-8 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-ivory-100 text-brandblue ring-1 ring-line">
          <FileQuestion className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-5 text-xs font-bold tracking-[0.14em] text-copper uppercase">
          404
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
          This page could not be found
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate">
          The task may have been removed, or the link is no longer valid.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/dashboard" className="btn-primary">
            Return to dashboard
          </Link>
          <Link href="/tasks" className="btn-secondary">
            View tasks
          </Link>
        </div>
      </div>
    </main>
  );
}
