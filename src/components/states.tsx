import Link from "next/link";
import { AlertTriangle, type LucideIcon } from "lucide-react";

/** Warm ivory page heading used across every application screen. */
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-[12px] font-bold tracking-[0.1em] text-copper uppercase">
          {eyebrow}
        </p>
        <h1 className="mt-1.5 text-[27px] font-bold tracking-[-0.035em] text-navy sm:text-[31px]">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-ivory-100 text-brandblue ring-1 ring-line">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-sm font-bold text-navy">{title}</h2>
      <p className="mt-2 max-w-sm text-[12px] leading-5 text-slate">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-fail/30 bg-fail-soft p-5"
    >
      <div className="flex gap-3">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-fail"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h2 className="text-[13px] font-bold text-fail-strong">{title}</h2>
          <p className="mt-1.5 text-[12px] leading-5 text-slate-700">
            {description}
          </p>
          {action && <div className="mt-4">{action}</div>}
        </div>
      </div>
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-fail/30 bg-fail-soft p-3 text-[12px] leading-5 font-medium text-fail-strong"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4">
          <span className="skeleton size-9 rounded-lg" />
          <span className="flex-1 space-y-2">
            <span className="skeleton block h-3 w-2/5 rounded" />
            <span className="skeleton block h-2.5 w-3/5 rounded" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Live-mode gate shown when GitHub is not connected or not configured. */
export function ConnectPrompt({
  title,
  description,
  missing = [],
}: {
  title: string;
  description: string;
  missing?: string[];
}) {
  return (
    <div className="card overflow-hidden">
      <div className="bg-navy px-6 py-7 sm:px-8">
        <p className="text-[11px] font-bold tracking-[0.1em] text-copper-300 uppercase">
          Live mode
        </p>
        <h2 className="mt-2 text-[19px] font-bold tracking-[-0.02em] text-ivory">
          {title}
        </h2>
        <p className="mt-2 max-w-xl text-[12px] leading-5 text-ivory/70">
          {description}
        </p>
      </div>
      <div className="px-6 py-6 sm:px-8">
        {missing.length > 0 ? (
          <>
            <p className="text-[11px] font-bold text-navy">
              Set these server variables, then restart Valmont:
            </p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {missing.map((name) => (
                <li
                  key={name}
                  className="rounded-md bg-ivory-100 px-2.5 py-1.5 text-[10px] font-bold text-slate-700 ring-1 ring-inset ring-line"
                >
                  {name}
                </li>
              ))}
            </ul>
            <Link href="/settings" className="btn-secondary mt-5 text-xs">
              Open settings
            </Link>
          </>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/api/auth/github" className="btn-primary">
              Connect GitHub
            </Link>
            <Link href="/settings" className="btn-secondary">
              Review configuration
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
