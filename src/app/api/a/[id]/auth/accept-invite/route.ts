import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { InvalidShopAgentLinkError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { setShopAgentSessionCookie } from "@/lib/shop-agent/auth";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { requireGatedShopDraft } from "@/lib/shop-agent/route-helpers";

const BODY_LIMIT_BYTES = 16_000;
const schema = z.object({
  token: z.string().min(16).max(256),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(128),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    await requireGatedShopDraft(id);
    assertApiRateLimit(request, "shop-agent-accept-invite", 10);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = schema.parse(body);
    const store = getShopAgentStore();
    const preview = await store.peekInvite(parsed.token);
    if (!preview || preview.draftId !== id)
      throw new InvalidShopAgentLinkError();
    const agent = await store.acceptInvite(
      parsed.token,
      parsed.name,
      parsed.password,
    );
    if (!agent || agent.draftId !== id) throw new InvalidShopAgentLinkError();
    const session = await store.createSession(agent.id);
    await store.touchLastLogin(agent.id);
    const response = NextResponse.json({
      agent: { id: agent.id, name: agent.name, email: agent.email },
    });
    setShopAgentSessionCookie(response, session.token);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
