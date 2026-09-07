import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { ConflictError, NotFoundError } from "@/lib/api-errors";
import { requireShopAdminsDraftAccess } from "@/lib/shop-admin/studio-routes";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { shopResetLink } from "@/lib/shop-admin/auth";
import { deliverShopAdminLink } from "@/lib/shop-admin/email";

/**
 * Studio → password-reset link for an active login. The agency user's way to
 * help an owner who is locked out and has no working email: the one-hour
 * link is emailed when a provider is configured, otherwise returned once.
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
    if (admin.status !== "active") {
      throw new ConflictError(
        admin.status === "invited"
          ? "This person has not set a password yet. Resend the invite instead."
          : "This login is disabled. Enable it before sending a reset link.",
      );
    }
    const issued = await store.createResetToken(adminId);
    const delivery = await deliverShopAdminLink({
      kind: "reset",
      to: admin.email,
      name: admin.name,
      shopName: draft.brief.businessName,
      link: shopResetLink(request.url, id, issued.token),
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
