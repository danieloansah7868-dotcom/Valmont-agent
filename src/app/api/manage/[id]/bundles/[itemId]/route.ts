import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ShopPermissionError,
} from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { shopCatalogueView } from "@/lib/shop-admin/bundle-view";
import { can } from "@/lib/shop-admin/permissions";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import {
  PACKAGE_NOT_INCLUDED_MESSAGE,
  planAllows,
  planOf,
} from "@/lib/studio/plans";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { priceAmount } from "@/lib/studio/site-brief/schema";

/**
 * Stage 6c — the shop edits its own bundles.
 *
 * PATCH with `{ price }` and/or `{ paused }`. Price is allowed on every
 * package; pausing additionally needs the `bundle_pause` feature
 * (Auto-Dispatch Pro and Command Center — a Starter shop is answered with the
 * standard package refusal). The route exists only for data-bundles
 * websites; every other category gets a 404, as if the path did not exist.
 *
 * The write goes through `patchCatalogueItemAsShop` on the draft store: one
 * item changed, whole brief re-validated, compare-and-set on the revision.
 * The response is a projection of the catalogue — never the brief, never
 * payment settings, never `adminEmail`.
 */

const BODY_LIMIT_BYTES = 16_000;
const BUNDLE_EDITS_PER_HOUR = 60;

const patchSchema = z
  .object({
    paused: z.boolean().optional(),
    price: priceAmount.optional(),
  })
  .refine(
    (patch) => patch.paused !== undefined || patch.price !== undefined,
    "Nothing to change",
  );

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    assertCsrf(request);
    const { id, itemId } = await params;
    const session = await requireShopAdminApi(request, id);
    if (!can(session.admin, "bundles.manage")) throw new ShopPermissionError();
    assertHourlyRateLimit("shop-bundle-edit", id, BUNDLE_EDITS_PER_HOUR);
    const parsed = patchSchema.parse(
      await readBoundedJson(request, BODY_LIMIT_BYTES),
    );

    // A price of zero is a slip of the finger, not a bundle price.
    if (parsed.price !== undefined && parsed.price <= 0) {
      throw new BadRequestError("Price must be more than zero.");
    }

    // The route does not exist for any other website type.
    const draft = await publicGetDraft(id);
    if (!draft || draft.brief.category !== "data-bundles") {
      throw new NotFoundError();
    }

    // Pausing is a packaged feature; changing a price never is.
    if (
      parsed.paused !== undefined &&
      !planAllows(planOf(draft.brief), "bundle_pause")
    ) {
      throw new ForbiddenError(PACKAGE_NOT_INCLUDED_MESSAGE);
    }

    const updated = await getStudioDraftStore().patchCatalogueItemAsShop(
      id,
      itemId,
      {
        ...(parsed.price !== undefined ? { price: parsed.price } : {}),
        ...(parsed.paused !== undefined ? { paused: parsed.paused } : {}),
      },
    );

    return NextResponse.json({ items: shopCatalogueView(updated.brief.items) });
  } catch (error) {
    return safeApiError(error);
  }
}
