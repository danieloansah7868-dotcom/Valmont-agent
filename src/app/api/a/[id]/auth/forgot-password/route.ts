import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { CustomerEmailDeliveryError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { agentResetLink } from "@/lib/shop-agent/auth";
import { deliverShopAgentLink } from "@/lib/shop-agent/email";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { requireGatedShopDraft } from "@/lib/shop-agent/route-helpers";

const BODY_LIMIT_BYTES = 16_000;
const schema = z.object({ email: z.string().trim().email().max(254) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const draft = await requireGatedShopDraft(id);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = schema.parse(body);
    const email = normalizeCustomerEmail(parsed.email);
    assertHourlyRateLimit("shop-agent-forgot-password", email, 5);
    assertApiRateLimit(request, "shop-agent-forgot-password-ip", 30);
    const store = getShopAgentStore();
    const agent = await store.getByEmail(id, email);
    if (agent?.status === "active") {
      const issued = await store.createResetToken(agent.id);
      try {
        await deliverShopAgentLink({
          kind: "reset",
          to: agent.email,
          name: agent.name,
          shopName: draft.brief.businessName,
          link: agentResetLink(request.url, id, issued.token),
        });
      } catch (error) {
        if (!(error instanceof CustomerEmailDeliveryError)) throw error;
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return safeApiError(error);
  }
}
