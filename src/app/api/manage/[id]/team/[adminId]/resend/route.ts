import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import {
  ConflictError,
  NotFoundError,
  ShopOwnerOnlyError,
} from "@/lib/api-errors";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi, shopInviteLink } from "@/lib/shop-admin/auth";
import { deliverShopAdminLink } from "@/lib/shop-admin/email";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { publicGetDraft } from "@/lib/studio/draft-public";

/** Owner-only: a fresh 24-hour invite link for a member who has not accepted yet. Never returns the link. */
const RESENDS_PER_HOUR = 10;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; adminId: string }> },
) {
  try {
    assertCsrf(request);
    const { id, adminId } = await params;
    const session = await requireShopAdminApi(request, id);
    if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
    assertHourlyRateLimit("shop-team-invite", id, RESENDS_PER_HOUR);

    const store = getShopAdminStore();
    const target = await store.getById(adminId);
    if (!target || target.draftId !== id) throw new NotFoundError();
    if (target.status !== "invited") {
      throw new ConflictError("This person has already set a password.");
    }
    const draft = await publicGetDraft(id);
    const issued = await store.createInviteToken(adminId);
    const delivery = await deliverShopAdminLink({
      kind: "invite",
      to: target.email,
      name: target.name,
      shopName: draft?.brief.businessName ?? "your shop",
      link: shopInviteLink(request.url, id, issued.token),
    });
    return NextResponse.json({ admin: target, delivered: delivery.delivered });
  } catch (error) {
    return safeApiError(error);
  }
}
