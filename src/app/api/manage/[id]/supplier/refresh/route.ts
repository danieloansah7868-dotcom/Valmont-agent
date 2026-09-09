import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import {
  ForbiddenError,
  NotFoundError,
  ShopPermissionError,
} from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { can } from "@/lib/shop-admin/permissions";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import {
  shopSupplierView,
  SHOP_SUPPLIER_REFRESH_MIN_INTERVAL_MS,
  SHOP_SUPPLIER_REFRESH_PER_HOUR,
  SHOP_SUPPLIER_REFRESH_RATE_LIMIT_OPERATION,
  SUPPLIER_NOT_CONNECTED_API_MESSAGE,
  SUPPLIER_REFRESH_TOO_SOON_MESSAGE,
} from "@/lib/shop-admin/supplier";
import { publicGetDraft } from "@/lib/studio/draft-public";
import {
  getTechChiefIntegration,
  testTechChiefConnection,
  type StudioIntegration,
} from "@/lib/studio/integrations";
import {
  PACKAGE_NOT_INCLUDED_MESSAGE,
  planAllows,
  planOf,
} from "@/lib/studio/plans";

/**
 * Stage 6d — "Refresh balance" on the shop's Supplier page.
 *
 * The route re-probes TechChief's wallet through the SAME library call the
 * Studio "Check balance" button uses (`testTechChiefConnection`), which
 * already spends exactly one slot of the website's 60/hour TechChief
 * allowance and refreshes the balance, the low-balance flag and the account
 * status on the connection row. The shop side adds two of its own ceilings
 * in front of it:
 *
 *  - at most {@link SHOP_SUPPLIER_REFRESH_PER_HOUR} refreshes per website per
 *    hour (the same `assertHourlyRateLimit` mechanism as every 6c route);
 *  - and never within {@link SHOP_SUPPLIER_REFRESH_MIN_INTERVAL_MS} of the
 *    last check — the balance cannot move in ten minutes, but two eager
 *    staff members refreshing together can cost real allowance.
 *
 * Every answer from the moment the integration is known carries the
 * {@link shopSupplierView} projection (never the key, the webhook URL or the
 * agency owner id), and the refused ones carry the `error` sentence too.
 * The page itself never calls TechChief; this route is the only shop-side
 * path that does.
 */

const BODY_LIMIT_BYTES = 16_000;

function answered(
  integration: StudioIntegration | null,
  extra: { error?: string } = {},
  status = 200,
): NextResponse {
  return NextResponse.json(
    { supplier: shopSupplierView(integration), ...extra },
    { status },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const session = await requireShopAdminApi(request, id);
    if (!can(session.admin, "supplier.manage")) {
      // The exact ShopPermissionError sentence answers a member without the
      // supplier.manage box.
      throw new ShopPermissionError();
    }
    assertHourlyRateLimit(
      SHOP_SUPPLIER_REFRESH_RATE_LIMIT_OPERATION,
      id,
      SHOP_SUPPLIER_REFRESH_PER_HOUR,
    );
    // The body is read (and size-bounded) but ignored — the client always
    // posts an empty JSON object.
    await readBoundedJson(request, BODY_LIMIT_BYTES);

    const draft = await publicGetDraft(id);
    if (!draft || draft.brief.category !== "data-bundles") {
      throw new NotFoundError();
    }
    if (!planAllows(planOf(draft.brief), "supplier_page")) {
      throw new ForbiddenError(PACKAGE_NOT_INCLUDED_MESSAGE);
    }

    // The no-secret reader: the route builds its view from the integration
    // record alone, never from the secrets record.
    const integration = await getTechChiefIntegration(id);
    if (!integration) {
      return answered(null, { error: SUPPLIER_NOT_CONNECTED_API_MESSAGE }, 404);
    }

    // The 10-minute rule is checked BEFORE any TechChief call, so a refusal
    // costs nothing — no budget slot, no probe.
    const lastCheckedAt = integration.lastCheckedAt
      ? Date.parse(integration.lastCheckedAt)
      : NaN;
    if (
      Number.isFinite(lastCheckedAt) &&
      Date.now() - lastCheckedAt < SHOP_SUPPLIER_REFRESH_MIN_INTERVAL_MS
    ) {
      return answered(
        integration,
        { error: SUPPLIER_REFRESH_TOO_SOON_MESSAGE },
        429,
      );
    }

    // One real wallet probe: it spends one budget slot and refreshes the
    // balance, low flag and status on the stored row.
    const result = await testTechChiefConnection(id);
    if (result.ok) {
      return answered(result.integration);
    }
    const error = result.message;
    const supplier = result.integration ?? integration;
    if (result.reason === "rejected") {
      return answered(supplier, { error }, 400);
    }
    if (result.reason === "budget") {
      return answered(supplier, { error }, 429);
    }
    if (result.reason === "unreachable") {
      return answered(supplier, { error }, 502);
    }
    // not_connected: a row exists but its key cannot be read on this server.
    return answered(supplier, { error }, 404);
  } catch (error) {
    return safeApiError(error);
  }
}
