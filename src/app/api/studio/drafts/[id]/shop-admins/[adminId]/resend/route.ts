import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { ConflictError, NotFoundError } from "@/lib/api-errors";
import { requireShopAdminsDraftAccess } from "@/lib/shop-admin/studio-routes";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { shopInviteLink } from "@/lib/shop-admin/auth";
import { deliverShopAdminLink } from "@/lib/shop-admin/email";

/**
 * Studio → resend an invite. Mints a fresh 24-hour link for a login that has
 * not accepted yet; earlier links stay valid until they expire or one is used.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; adminId: string }> },
) {
  try {
    const { id, adminId } = await params;
    const { draft } = await requireShopAdminsDraftAccess(request, id, {
      mutating: true,
    });
    const store = getShopAdminStore();
    const admin = await store.getById(adminId);
    if (!admin || admin.draftId !== id) throw new NotFoundError();
    if (admin.status !== "invited") {
      throw new ConflictError(
        "This person has already set a password. Send a reset link instead.",
      );
    }
    const issued = await store.createInviteToken(adminId);
    const delivery = await deliverShopAdminLink({
      kind: "invite",
      to: admin.email,
      name: admin.name,
      shopName: draft.brief.businessName,
      link: shopInviteLink(request.url, id, issued.token),
    });
    return NextResponse.json({
      admin,
      delivered: delivery.delivered,
      expiresAt: issued.expiresAt,
      ...(delivery.link ? { link: delivery.link } : {}),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
