import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  assertApiRateLimit,
  assertCustomerRateLimit,
  safeApiError,
} from "@/lib/api";
import { InvalidShopAgentCredentialsError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import {
  safeAgentReturnPath,
  setShopAgentSessionCookie,
} from "@/lib/shop-agent/auth";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { requireGatedShopDraft } from "@/lib/shop-agent/route-helpers";

const BODY_LIMIT_BYTES = 16_000;
const schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  next: z.string().max(512).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    await requireGatedShopDraft(id);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = schema.parse(body);
    const email = normalizeCustomerEmail(parsed.email);
    assertCustomerRateLimit(request, "shop-agent-login", email, 10);
    assertApiRateLimit(request, "shop-agent-login-ip", 30);
    const agent = await getShopAgentStore().verifyPassword(
      id,
      email,
      parsed.password,
    );
    if (!agent) throw new InvalidShopAgentCredentialsError();
    const session = await getShopAgentStore().createSession(agent.id);
    await getShopAgentStore().touchLastLogin(agent.id);
    const response = NextResponse.json({
      agent: { id: agent.id, name: agent.name, email: agent.email },
      next: safeAgentReturnPath(id, parsed.next),
    });
    setShopAgentSessionCookie(response, session.token);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
