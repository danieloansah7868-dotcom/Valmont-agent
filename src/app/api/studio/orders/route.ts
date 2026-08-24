import { NextResponse, type NextRequest } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { safeApiError } from "@/lib/api";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore } from "@/lib/studio/orders";
import { ORDER_FILTERS, type OrderFilterId } from "@/lib/studio/order-status";

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiSessionUser();
    const ownerId = canonicalUserId(user);
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
    const filterParam = request.nextUrl.searchParams.get("filter") ?? "all";
    const filter = ORDER_FILTERS.some((entry) => entry.id === filterParam)
      ? (filterParam as OrderFilterId)
      : "all";
    const orders = await getOrdersStore().listForOwner(ownerId, {
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
      filter,
    });
    return NextResponse.json({ orders });
  } catch (error) {
    return safeApiError(error);
  }
}
