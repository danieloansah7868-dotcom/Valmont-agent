/**
 * Shared guards for the Studio → TechChief connection routes (Stage 5).
 *
 * Every route under `/api/studio/drafts/[id]/integrations/techchief` needs the
 * same four things in the same order, and getting the order wrong is how a
 * cross-tenant read leaks: authenticate, check CSRF on anything that mutates,
 * take the owner's rate-limit slot, then prove the draft belongs to the caller
 * — a draft that is not theirs is a plain 404, exactly like a draft that does
 * not exist, so the endpoint cannot be used to discover ids.
 *
 * Keeping the preamble here means a new route cannot forget one of them.
 */

import type { NextRequest } from "next/server";
import { requireApiSessionUser, type SessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit } from "@/lib/api";
import { NotFoundError } from "@/lib/api-errors";
import { canonicalUserId } from "@/lib/user-identity";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import type { StudioDraft } from "@/lib/studio/site-brief/schema";
import {
  techChiefConnectionView,
  type StudioIntegration,
  type TechChiefConnectionView,
} from "@/lib/studio/integrations";

/** Rate-limit bucket for every TechChief connection action. */
export const TECHCHIEF_INTEGRATION_RATE_LIMIT_OPERATION = "studio-integration";
export const TECHCHIEF_INTEGRATION_RATE_LIMIT = 30;

export interface TechChiefRouteAccess {
  user: SessionUser;
  ownerId: string;
  draft: StudioDraft;
}

/**
 * Authenticates, guards and owner-scopes one connection request.
 *
 * Throws the typed errors `safeApiError` turns into 401 / 403 / 429 / 404, so
 * a route handler only has to wrap the call in its usual try/catch.
 */
export async function requireTechChiefDraftAccess(
  request: NextRequest,
  draftId: string,
  options: { mutating: boolean },
): Promise<TechChiefRouteAccess> {
  const user = await requireApiSessionUser();
  if (options.mutating) assertCsrf(request);
  const ownerId = canonicalUserId(user);
  assertOwnerRateLimit(
    TECHCHIEF_INTEGRATION_RATE_LIMIT_OPERATION,
    ownerId,
    TECHCHIEF_INTEGRATION_RATE_LIMIT,
  );

  // `get` is owner-scoped: another person's website and a made-up id produce
  // the same 404, and nothing reveals which one it was.
  const draft = await getStudioDraftStore().get(user, draftId);
  if (!draft) throw new NotFoundError("Not found");

  return { user, ownerId, draft };
}

/**
 * The connection as this website's owner may see it.
 *
 * Unmatched catalogue items are only reported for a data-bundles website: on
 * any other kind of site every priced item would be listed as "TechChief does
 * not sell this", which is true and useless.
 */
export function techChiefViewFor(
  draft: StudioDraft,
  integration: StudioIntegration | null,
): TechChiefConnectionView {
  const isBundleSite = draft.brief.category === "data-bundles";
  return techChiefConnectionView(
    integration,
    isBundleSite ? draft.brief : undefined,
  );
}
