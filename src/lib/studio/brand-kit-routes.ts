/**
 * Stage B — shared guards for the Studio Brand Kit routes.
 *
 * Every route under `/api/studio/drafts/[id]/brand-kit` needs the same
 * things in the same order, mirroring the TechChief connection routes:
 * authenticate, check CSRF on anything that mutates, prove the draft belongs
 * to the caller (another person's draft is a plain 404, exactly like a
 * made-up id), then apply the package gate — a data-bundles website on
 * Starter or Auto-Dispatch without the paid add-on gets the standard 403
 * packaged refusal, every other website type is always allowed.
 *
 * Rate limiting stays in the routes, because the budgets differ: the suggest
 * route burns model calls and gets the hourly `brand-kit` budget from
 * brand-kit.ts, while the write/read routes share the ordinary studio
 * mutation budget.
 */
import type { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/auth";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { ForbiddenError, NotFoundError } from "@/lib/api-errors";
import { canonicalUserId } from "@/lib/user-identity";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import type { StudioDraft } from "@/lib/studio/site-brief/schema";
import { PACKAGE_NOT_INCLUDED_MESSAGE, brandKitAllowed } from "./plans";

export interface BrandKitRouteAccess {
  user: SessionUser;
  ownerId: string;
  draft: StudioDraft;
}

/**
 * Authenticates, owner-scopes and package-gates one Brand Kit request.
 *
 * Throws the typed errors `safeApiError` turns into 401 / 403 / 404, so a
 * route handler only has to wrap the call in its usual try/catch.
 */
export async function requireBrandKitDraftAccess(
  request: NextRequest,
  draftId: string,
  options: { mutating: boolean },
): Promise<BrandKitRouteAccess> {
  const user = await requireApiSessionUser();
  if (options.mutating) assertCsrf(request);
  const ownerId = canonicalUserId(user);

  // `get` is owner-scoped: another agency user's website and a made-up id
  // produce the same 404, and nothing reveals which one it was.
  const draft = await getStudioDraftStore().get(user, draftId);
  if (!draft) throw new NotFoundError("Not found");

  // The package gate sits on the brief, read defensively: a pre-Stage-B row
  // has no `brandKitAddon` key and resolves to the Auto-Dispatch default.
  if (!brandKitAllowed(draft.brief)) {
    throw new ForbiddenError(PACKAGE_NOT_INCLUDED_MESSAGE);
  }

  return { user, ownerId, draft };
}

/** Body ceiling for the Brand Kit POSTs — the answers are tiny. */
export const BRAND_KIT_BODY_LIMIT_BYTES = 16_000; // 16 KB
