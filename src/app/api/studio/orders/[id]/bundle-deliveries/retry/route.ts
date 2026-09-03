import { NextResponse, type NextRequest } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { canonicalUserId } from "@/lib/user-identity";
import { retryBundleDeliveryFailures } from "@/lib/studio/bundle-delivery";

/**
 * Owner-only "Retry" for failed bundle top-ups (Stage 4). Re-dispatches only
 * the rows at "failed" on the owner's explicit request; in-flight and
 * delivered rows are never touched. Owner scoping happens inside the engine
 * before any delivery row is revealed, so a cross-tenant order id is a 404.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const user = await requireApiSessionUser();
    const ownerId = canonicalUserId(user);
    assertOwnerRateLimit("studio-order-delivery", ownerId, 40);
    const { id } = await params;

    const result = await retryBundleDeliveryFailures(ownerId, id);
    if (!result) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    return NextResponse.json({ deliveries: result.deliveries });
  } catch (error) {
    return safeApiError(error);
  }
}
