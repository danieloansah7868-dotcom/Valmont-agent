import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { ShopOwnerOnlyError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi, shopInviteLink } from "@/lib/shop-admin/auth";
import { deliverShopAdminLink } from "@/lib/shop-admin/email";
import { SHOP_PERMISSIONS } from "@/lib/shop-admin/permissions";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { publicGetDraft } from "@/lib/studio/draft-public";

/**
 * Shop team (Stage 6b). GET lists the team for any signed-in admin of this
 * shop; POST invites a member and is owner-only. The owner ticks permission
 * boxes per person — there are no fixed roles below "owner".
 *
 * Unlike the Studio-side invite, this endpoint never returns a link: the
 * owner is a shop user, not the deployment's operator. If email is not
 * configured the response says so and the owner asks the agency to pass the
 * link on from Studio.
 */

const BODY_LIMIT_BYTES = 16_000;
const INVITES_PER_HOUR = 10;

const inviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  permissions: z.array(z.enum(SHOP_PERMISSIONS)).max(SHOP_PERMISSIONS.length),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireShopAdminApi(request, id);
    const admins = await getShopAdminStore().listForDraft(id);
    return NextResponse.json({ admins });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const session = await requireShopAdminApi(request, id);
    if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = inviteSchema.parse(body);
    assertHourlyRateLimit("shop-team-invite", id, INVITES_PER_HOUR);

    const draft = await publicGetDraft(id);
    const store = getShopAdminStore();
    const invite = await store.createMemberInvite({
      draftId: id,
      email: parsed.email,
      name: parsed.name,
      permissions: parsed.permissions,
      invitedBy: session.admin.id,
    });
    const delivery = await deliverShopAdminLink({
      kind: "invite",
      to: invite.admin.email,
      name: invite.admin.name,
      shopName: draft?.brief.businessName ?? "your shop",
      link: shopInviteLink(request.url, id, invite.token),
    });
    // Deliberately no `link` here, whatever `delivery` holds.
    return NextResponse.json(
      { admin: invite.admin, delivered: delivery.delivered },
      { status: 201 },
    );
  } catch (error) {
    return safeApiError(error);
  }
}
