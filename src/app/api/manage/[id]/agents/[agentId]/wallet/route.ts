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
const amountSchema = z
  .number()
  .positive()
  .max(5000)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001,
  );
const walletSchema = z.object({
  kind: z.enum(["credit", "deduct"]),
  amount: amountSchema,
  note: z.string().trim().max(140).optional(),
});

async function ownerWalletAccess(
  request: NextRequest,
  id: string,
  mutating: boolean,
) {
  if (mutating) assertCsrf(request);
  const session = await requireShopAdminApi(request, id);
  const draft = await publicGetDraft(id);
  if (!draft) throw new NotFoundError();
  assertShopAgentsAllowed(draft.brief);
  if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
  return session;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  try {
    const { id, agentId } = await params;
    await ownerWalletAccess(request, id, false);
    assertHourlyRateLimit("shop-agent-wallet", id, 60);
    const store = getShopAgentStore();
    const agent = await store.getById(agentId);
    if (!agent || agent.draftId !== id) throw new NotFoundError();
    return NextResponse.json({
      entries: await store.listEntries(agentId, 100),
    });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  try {
    const { id, agentId } = await params;
    const session = await ownerWalletAccess(request, id, true);
    assertHourlyRateLimit("shop-agent-wallet", id, 60);
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = walletSchema.parse(body);
    const store = getShopAgentStore();
    const agent = await store.getById(agentId);
    if (!agent || agent.draftId !== id) throw new NotFoundError();
    const amountMinor = Math.round(parsed.amount * 100);
    const entry =
      parsed.kind === "credit"
        ? await store.credit({
            agentId,
            amountMinor,
            note: parsed.note,
            createdBy: session.admin.id,
          })
        : await store.deduct({
            agentId,
            amountMinor,
            note: parsed.note,
            createdBy: session.admin.id,
          });
    const updated = await store.getById(agentId);
    if (!updated) throw new NotFoundError();
    return NextResponse.json({ entry, agent: updated }, { status: 201 });
  } catch (error) {
    return safeApiError(error);
  }
}
