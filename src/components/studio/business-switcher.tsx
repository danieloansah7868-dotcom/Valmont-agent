"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export interface BusinessOption {
  id: string;
  name: string;
}

/** A compact owner-scoped switcher shared by the Studio pages. */
export function BusinessSwitcher({
  businesses,
  selectedBusinessId,
  basePath,
  filter,
}: {
  businesses: BusinessOption[];
  selectedBusinessId?: string;
  basePath: string;
  filter?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function switchBusiness(value: string) {
    const params = new URLSearchParams();
    if (value !== "all") params.set("business", value);
    if (filter && filter !== "all") params.set("filter", filter);
    const query = params.toString();
    startTransition(() => {
      router.push(`${basePath}${query ? `?${query}` : ""}`);
    });
  }

  return (
    <label className="block min-w-0 sm:min-w-64">
      <span className="label">Current business</span>
      <select
        className="select"
        value={selectedBusinessId ?? "all"}
        onChange={(event) => switchBusiness(event.target.value)}
        disabled={isPending}
        aria-label="Switch business"
        data-testid="business-switcher"
      >
        <option value="all">All businesses</option>
        {businesses.map((business) => (
          <option key={business.id} value={business.id}>
            {business.name}
          </option>
        ))}
      </select>
      {isPending && (
        <span className="mt-1 block text-xs text-slate-500" aria-live="polite">
          Opening…
        </span>
      )}
    </label>
  );
}
