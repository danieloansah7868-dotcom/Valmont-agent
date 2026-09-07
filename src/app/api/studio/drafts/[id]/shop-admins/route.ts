import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { requireShopAdminsDraftAccess } from "@/lib/shop-admin/studio-routes";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { shopInviteLink } from "@/lib/shop-admin/auth";
import {
  deliverShopAdminLink,
  shopAdminEmailConfigured,
} from "@/lib/shop-admin/email";

/**
 * Studio → Shop logins (Stage 6b).
 *
 * GET lists every login on this website — owner and members — without hashes
 * or tokens. POST creates the one owner login and its first invite link. The
 * shop owner adds their own staff later from `/manage/[id]/team`; the agency
 * user is only ever needed for the first login.
 *
 * Delivery follows one rule: when email is configured the link goes by email
 * and never comes back in the response; when it is not, the response carries
 * the link *once* so the agency user can send it on WhatsApp.
 */

const BODY_LIMIT_BYTES = 16_000;

const inviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireShopAdminsDraftAccess(request, id, { mutating: false });
    const admins = await getShopAdminStore().listForDraft(id);
    return NextResponse.json({
      admins,
      emailConfigured: shopAdminEmailConfigured(),
    });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { ownerId, draft } = await requireShopAdminsDraftAccess(request, id, {
      mutating: true,
    });
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = inviteSchema.parse(body);

    const invite = await getShopAdminStore().createOwnerInvite({
      draftId: id,
      email: parsed.email,
      name: parsed.name,
      invitedBy: ownerId,
    });
    const delivery = await deliverShopAdminLink({
      kind: "invite",
      to: invite.admin.email,
      name: invite.admin.name,
      shopName: draft.brief.businessName,
      link: shopInviteLink(request.url, id, invite.token),
    });
    return NextResponse.json(
      {
        admin: invite.admin,
        delivered: delivery.delivered,
        expiresAt: invite.expiresAt,
        ...(delivery.link ? { link: delivery.link } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    return safeApiError(error);
  }
}
