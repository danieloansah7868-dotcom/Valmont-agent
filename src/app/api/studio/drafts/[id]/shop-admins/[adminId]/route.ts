import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { NotFoundError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { requireShopAdminsDraftAccess } from "@/lib/shop-admin/studio-routes";
import { getShopAdminStore } from "@/lib/shop-admin/store";

/**
 * Studio → one shop login. The agency user may disable or re-enable any login
 * on their own website (the owner included — this is the agency's escape
 * hatch when a shop changes hands). There is no delete: a disabled login
 * keeps its audit trail and can be re-enabled.
 */

const BODY_LIMIT_BYTES = 16_000;

const patchSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; adminId: string }> },
) {
  try {
    const { id, adminId } = await params;
    await requireShopAdminsDraftAccess(request, id, { mutating: true });
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = patchSchema.parse(body);

    const store = getShopAdminStore();
    const admin = await store.getById(adminId);
    // A login on some other website is not this website's business: 404.
    if (!admin || admin.draftId !== id) throw new NotFoundError();
    // Re-enabling someone who never accepted their invite would leave them
    // "active" with no password; they go back to waiting for the link.
    const nextStatus =
      parsed.status === "active" && !admin.hasPassword
        ? "invited"
        : parsed.status;
    const updated = await store.setStatus(adminId, nextStatus);
    if (!updated) throw new NotFoundError();
    return NextResponse.json({ admin: updated });
  } catch (error) {
    return safeApiError(error);
  }
}
