import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { testTechChiefConnection } from "@/lib/studio/integrations";
import {
  requireTechChiefDraftAccess,
  techChiefViewFor,
} from "@/lib/studio/techchief-routes";

/**
 * "Check balance" (Stage 5). Re-probes `dev_wallet.php` and refreshes the
 * balance, TechChief's own low-balance flag and the account status.
 *
 * A key TechChief now rejects flips the connection to `error` with an
 * owner-readable reason, because a revoked key must stop counting as a live
 * delivery provider at once; an unreachable API leaves the verified status
 * alone, since a network blip says nothing about the key. Both answers carry
 * the current connection view so the card can render without a second request.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { draft } = await requireTechChiefDraftAccess(request, id, {
      mutating: true,
    });

    const result = await testTechChiefConnection(id);

    if (!result.ok) {
      const status =
        result.reason === "not_connected"
          ? 404
          : result.reason === "budget"
            ? 429
            : result.reason === "rejected"
              ? 400
              : 502;
      return NextResponse.json(
        {
          error: result.message,
          connection: techChiefViewFor(draft, result.integration ?? null),
        },
        { status },
      );
    }

    return NextResponse.json({
      connection: techChiefViewFor(draft, result.integration),
      walletBalance: result.wallet.walletBalance,
      lowBalance: result.wallet.lowBalance,
    });
  } catch (error) {
    return safeApiError(error);
  }
}
