/**
 * Shared guard for the Studio → Shop logins routes (Stage 6b).
 *
 * These routes live on the *agency* side: the GitHub-connected Studio user who
 * built the website creates the shop owner's first login from the wizard.
 * They therefore use the agency session — and they are the only part of the
 * shop-admin feature that does. Nothing under `/api/manage/[id]` or
 * `/manage/[id]` imports this file or `@/lib/auth`.
 *
 * Same preamble and same order as `techchief-routes.ts`: authenticate, CSRF on
 * anything that mutates, take the owner's rate-limit slot, then prove the
 * draft belongs to the caller. Another agency user's draft is a plain 404,
 * exactly like a draft that does not exist.
 */

import type { NextRequest } from "next/server";
import { requireApiSessionUser, type SessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit } from "@/lib/api";
import { NotFoundError } from "@/lib/api-errors";
import { canonicalUserId } from "@/lib/user-identity";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import type { StudioDraft } from "@/lib/studio/site-brief/schema";

/** Rate-limit bucket for every Studio-side shop-login action. */
export const SHOP_ADMINS_RATE_LIMIT_OPERATION = "shop-admins";
export const SHOP_ADMINS_RATE_LIMIT = 30;

export interface ShopAdminsRouteAccess {
  user: SessionUser;
  ownerId: string;
  draft: StudioDraft;
}

export async function requireShopAdminsDraftAccess(
  request: NextRequest,
  draftId: string,
  options: { mutating: boolean },
): Promise<ShopAdminsRouteAccess> {
  const user = await requireApiSessionUser();
  if (options.mutating) assertCsrf(request);
  const ownerId = canonicalUserId(user);
  assertOwnerRateLimit(
    SHOP_ADMINS_RATE_LIMIT_OPERATION,
    ownerId,
    SHOP_ADMINS_RATE_LIMIT,
  );

  // `get` is owner-scoped: another person's website and a made-up id produce
  // the same 404, and nothing reveals which one it was.
  const draft = await getStudioDraftStore().get(user, draftId);
  if (!draft) throw new NotFoundError("Not found");

  return { user, ownerId, draft };
}
