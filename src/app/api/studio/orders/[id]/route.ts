import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore } from "@/lib/studio/orders";
import { ALL_ORDER_STATUSES } from "@/lib/studio/order-status";
import { readBoundedJson } from "@/lib/bounded-json";
import { notifyCustomerOrderStatus } from "@/lib/customer-order-notifications";

export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiSessionUser();
    const { id } = await params;
    const order = await getOrdersStore().getForOwner(canonicalUserId(user), id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    return NextResponse.json(order);
  } catch (error) {
    return safeApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const user = await requireApiSessionUser();
    const ownerId = canonicalUserId(user);
    assertOwnerRateLimit("studio-order", ownerId, 40);
    const { id } = await params;
    const body = (await readBoundedJson(
      request as unknown as Request,
      4_000,
    )) as Record<string, unknown>;
    const { status } = z
      .object({ status: z.enum(ALL_ORDER_STATUSES) })
      .parse(body);
    const orders = getOrdersStore();
    const existing = await orders.getForOwner(ownerId, id);
    if (!existing) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    const updated = await orders.updateStatus(ownerId, id, status);
    if (!updated) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Updating the status is the source of truth; a customer email is a
    // best-effort side effect and must never turn a successful merchant update
    // into an error. The pre-check also keeps a repeated same-status PATCH from
    // sending a duplicate notification.
    if (existing.status !== status) {
      await notifyCustomerOrderStatus({
        order: updated,
        origin: request.nextUrl.origin,
      }).catch(() => "failed");
    }
    return NextResponse.json(updated);
  } catch (error) {
    return safeApiError(error);
  }
}
