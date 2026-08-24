import { NextResponse } from "next/server";
import { getOrdersStore } from "@/lib/studio/orders";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const order = await getOrdersStore().getByAccessCode(code);
  if (!order)
    return NextResponse.json(
      { error: "Order not found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  return NextResponse.json(
    { status: order.status },
    { headers: { "cache-control": "no-store" } },
  );
}
