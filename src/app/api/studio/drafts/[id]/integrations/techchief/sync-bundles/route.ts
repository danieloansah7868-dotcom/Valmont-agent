import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import {
  getTechChiefIntegration,
  syncTechChiefBundles,
  TECHCHIEF_UNREACHABLE_MESSAGE,
} from "@/lib/studio/integrations";
import {
  requireTechChiefDraftAccess,
  techChiefViewFor,
} from "@/lib/studio/techchief-routes";

/**
 * "Sync bundles" (Stage 5).
 *
 * TechChief sells by bundle **id**, never by size, so a shop can only deliver
 * what it has matched against their current price list. This downloads every
 * network they sell, caches it on the connection and answers with the count
 * plus the shop's own items that have no match — the list an owner needs in
 * order to fix a catalogue item before a customer pays for it.
 *
 * The sync costs one request per network out of TechChief's 60/hour and stops
 * early when the hourly budget is spent; a failed sync keeps the previous
 * cache rather than emptying it, so a shop that was delivering keeps
 * delivering.
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

    const integration = await getTechChiefIntegration(id);
    if (!integration) {
      return NextResponse.json(
        { error: "This website has no TechChief key saved yet." },
        { status: 404 },
      );
    }

    const synced = await syncTechChiefBundles(integration.id);
    if (!synced) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const connection = techChiefViewFor(draft, synced.integration);
    if (!synced.synced) {
      return NextResponse.json(
        {
          error: synced.error ?? TECHCHIEF_UNREACHABLE_MESSAGE,
          connection,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      connection,
      count: synced.count,
      unmatchedItems: connection.unmatchedItems,
    });
  } catch (error) {
    return safeApiError(error);
  }
}
