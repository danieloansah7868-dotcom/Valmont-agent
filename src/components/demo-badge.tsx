import { FlaskConical } from "lucide-react";

/**
 * Only rendered when an operator has explicitly set `ENABLE_DEMO_MODE=true`.
 * In the default live mode nothing in the interface shows this badge.
 */
export function DemoBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-copper-50 px-2.5 py-1 text-[11px] font-bold text-copper-700 ring-1 ring-inset ring-copper-300">
      <FlaskConical className="size-3" aria-hidden="true" />
      {compact ? "Demo" : "Demo mode"}
    </span>
  );
}
