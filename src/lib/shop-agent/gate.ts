import { ForbiddenError } from "@/lib/api-errors";
import {
  PACKAGE_NOT_INCLUDED_MESSAGE,
  planAllows,
  planOf,
} from "@/lib/studio/plans";

export function shopAgentsAllowed(
  brief: { category?: string; plan?: string } | null | undefined,
): boolean {
  return Boolean(
    brief &&
    brief.category === "data-bundles" &&
    planAllows(planOf(brief), "wallets"),
  );
}

export function assertShopAgentsAllowed(
  brief: { category?: string; plan?: string } | null | undefined,
): void {
  if (!shopAgentsAllowed(brief))
    throw new ForbiddenError(PACKAGE_NOT_INCLUDED_MESSAGE);
}
