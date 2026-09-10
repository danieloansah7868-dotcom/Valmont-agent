import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { NotFoundError, ShopOwnerOnlyError } from "@/lib/api-errors";
import { assertShopAgentsAllowed } from "@/lib/shop-agent/gate";
import { getShopAgentStore } from "@/lib/shop-agent/store";

const BODY_LIMIT_BYTES = 16_000;
const schema = z.object({ discountPercent: z.number().int().min(0).max(50) });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const session = await requireShopAdminApi(request, id);
    const draft = await publicGetDraft(id);
    if (!draft) throw new NotFoundError();
    assertShopAgentsAllowed(draft.brief);
    if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
    assertHourlyRateLimit("shop-agent-settings", id, 20);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = schema.parse(body);
    const settings = await getShopAgentStore().setDiscountPercent(
      id,
      parsed.discountPercent,
    );
    return NextResponse.json({ settings });
  } catch (error) {
    return safeApiError(error);
  }
}
