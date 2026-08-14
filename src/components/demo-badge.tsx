import { FlaskConical } from "lucide-react";

export function DemoBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fff5dc] px-2.5 py-1 text-[11px] font-bold text-[#895012] ring-1 ring-inset ring-[#ebd6a7]">
      <FlaskConical className="size-3" aria-hidden="true" />
      {compact ? "Demo" : "Demo mode"}
    </span>
  );
}
