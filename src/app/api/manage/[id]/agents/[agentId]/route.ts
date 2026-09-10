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

const statusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const BODY_LIMIT_BYTES = 16_000;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  try {
    assertCsrf(request);
    const { id, agentId } = await params;
    const session = await requireShopAdminApi(request, id);
    const draft = await publicGetDraft(id);
    if (!draft) throw new NotFoundError();
    assertShopAgentsAllowed(draft.brief);
    if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
    assertHourlyRateLimit("shop-agent-status", id, 30);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = statusSchema.parse(body);
    const store = getShopAgentStore();
    const current = await store.getById(agentId);
    if (!current || current.draftId !== id) throw new NotFoundError();
    const agent = await store.setStatus(agentId, parsed.status);
    if (!agent) throw new NotFoundError();
    return NextResponse.json({ agent });
  } catch (error) {
    return safeApiError(error);
  }
}
