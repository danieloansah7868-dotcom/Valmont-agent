import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import {
  NotFoundError,
  ShopOwnerLockedError,
  ShopOwnerOnlyError,
} from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { SHOP_PERMISSIONS } from "@/lib/shop-admin/permissions";
import { getShopAdminStore } from "@/lib/shop-admin/store";

/**
 * One team member: change their permission boxes, disable or re-enable them.
 * Owner-only. The owner row itself is locked — an owner cannot disable
 * themselves or hand their permissions to anyone from here; only the agency
 * can change the owner login, from Studio. There is no delete: a disabled
 * member keeps their history and can be re-enabled.
 */

const BODY_LIMIT_BYTES = 16_000;

const patchSchema = z
  .object({
    permissions: z
      .array(z.enum(SHOP_PERMISSIONS))
      .max(SHOP_PERMISSIONS.length)
      .optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine(
    (value) => value.permissions !== undefined || value.status !== undefined,
    { message: "Nothing to change" },
  );

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; adminId: string }> },
) {
  try {
    assertCsrf(request);
    const { id, adminId } = await params;
    const session = await requireShopAdminApi(request, id);
    if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = patchSchema.parse(body);

    const store = getShopAdminStore();
    const target = await store.getById(adminId);
    if (!target || target.draftId !== id) throw new NotFoundError();
    if (target.role === "owner") throw new ShopOwnerLockedError();

    let updated = target;
    if (parsed.permissions !== undefined) {
      updated =
        (await store.setPermissions(adminId, parsed.permissions)) ?? updated;
    }
    if (parsed.status !== undefined) {
      // Re-enabling someone who never accepted their invite sends them back
      // to "invited" rather than leaving an "active" login with no password.
      const nextStatus =
        parsed.status === "active" && !target.hasPassword
          ? "invited"
          : parsed.status;
      updated = (await store.setStatus(adminId, nextStatus)) ?? updated;
    }
    return NextResponse.json({ admin: updated });
  } catch (error) {
    return safeApiError(error);
  }
}
