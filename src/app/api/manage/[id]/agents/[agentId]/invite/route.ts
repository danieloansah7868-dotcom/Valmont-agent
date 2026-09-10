import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { publicGetDraft } from "@/lib/studio/draft-public";
import {
  NotFoundError,
  ShopAgentAlreadyActiveError,
  ShopOwnerOnlyError,
} from "@/lib/api-errors";
import { agentInviteLink } from "@/lib/shop-agent/auth";
import { deliverShopAgentLink } from "@/lib/shop-agent/email";
import { assertShopAgentsAllowed } from "@/lib/shop-agent/gate";
import { getShopAgentStore } from "@/lib/shop-agent/store";

const BODY_LIMIT_BYTES = 16_000;
const emptySchema = z.object({});

export async function POST(
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
    assertHourlyRateLimit("shop-agent-invite", id, 10);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    emptySchema.parse(body);
    const store = getShopAgentStore();
    const agent = await store.getById(agentId);
    if (!agent || agent.draftId !== id) throw new NotFoundError();
    if (agent.status !== "invited") throw new ShopAgentAlreadyActiveError();
    const issued = await store.createInviteToken(agent.id);
    const delivered = await deliverShopAgentLink({
      kind: "invite",
      to: agent.email,
      name: agent.name,
      shopName: draft.brief.businessName,
      link: agentInviteLink(request.url, id, issued.token),
    });
    return NextResponse.json({ delivered: delivered.delivered });
  } catch (error) {
    return safeApiError(error);
  }
}
