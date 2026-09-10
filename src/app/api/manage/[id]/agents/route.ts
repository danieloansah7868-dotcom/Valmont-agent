import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { NotFoundError, ShopOwnerOnlyError } from "@/lib/api-errors";
import { agentInviteLink } from "@/lib/shop-agent/auth";
import { deliverShopAgentLink } from "@/lib/shop-agent/email";
import { assertShopAgentsAllowed } from "@/lib/shop-agent/gate";
import { getShopAgentStore } from "@/lib/shop-agent/store";

const BODY_LIMIT_BYTES = 16_000;
const inviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(30).optional(),
});

async function ownerDraft(request: NextRequest, id: string, mutating: boolean) {
  if (mutating) assertCsrf(request);
  const session = await requireShopAdminApi(request, id);
  const draft = await publicGetDraft(id);
  if (!draft) throw new NotFoundError();
  assertShopAgentsAllowed(draft.brief);
  if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
  return { session, draft };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await ownerDraft(request, id, false);
    assertHourlyRateLimit("shop-agent-list", id, 60);
    const store = getShopAgentStore();
    return NextResponse.json({
      agents: await store.listForDraft(id),
      settings: await store.getSettings(id),
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
    const { draft, session } = await ownerDraft(request, id, true);
    assertHourlyRateLimit("shop-agent-invite", id, 10);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = inviteSchema.parse(body);
    const store = getShopAgentStore();
    const agent = await store.createInvite({
      ...parsed,
      draftId: id,
      invitedBy: session.admin.id,
    });
    const issued = await store.createInviteToken(agent.id);
    const deliveredResult = await deliverShopAgentLink({
      kind: "invite",
      to: agent.email,
      name: agent.name,
      shopName: draft.brief.businessName,
      link: agentInviteLink(request.url, id, issued.token),
    });
    return NextResponse.json(
      { agent, delivered: deliveredResult.delivered },
      { status: 201 },
    );
  } catch (error) {
    return safeApiError(error);
  }
}
