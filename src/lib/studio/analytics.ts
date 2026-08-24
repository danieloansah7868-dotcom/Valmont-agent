import type { OrderRecord } from "./orders";

export interface StudioAnalytics {
  paidOrders: number;
  paidRevenue: number;
  averageOrderValue: number;
  topItems: Array<{ name: string; quantity: number; revenue: number }>;
  paymentMethods: Array<{ method: string; orders: number; revenue: number }>;
  busiestHours: Array<{ hour: number; orders: number }>;
}

/** Summarises settled orders only; pending, cancelled and failed orders never inflate sales. */
export function summariseOrders(orders: OrderRecord[]): StudioAnalytics {
  const paid = orders.filter((order) =>
    [
      "paid",
      "preparing",
      "out_for_delivery",
      "delivered",
      "fulfilled",
    ].includes(order.status),
  );
  const itemTotals = new Map<string, { quantity: number; revenue: number }>();
  const methods = new Map<string, { orders: number; revenue: number }>();
  const hours = new Map<number, number>();
  let paidRevenue = 0;

  for (const order of paid) {
    paidRevenue += order.total;
    const method = methods.get(order.paymentMethod) ?? {
      orders: 0,
      revenue: 0,
    };
    method.orders += 1;
    method.revenue += order.total;
    methods.set(order.paymentMethod, method);
    const hour = new Date(order.createdAt).getUTCHours();
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
    for (const line of order.lines) {
      const item = itemTotals.get(line.name) ?? { quantity: 0, revenue: 0 };
      item.quantity += line.quantity;
      item.revenue += line.quantity * line.price;
      itemTotals.set(line.name, item);
    }
  }

  return {
    paidOrders: paid.length,
    paidRevenue,
    averageOrderValue: paid.length ? paidRevenue / paid.length : 0,
    topItems: [...itemTotals.entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.revenue - a.revenue),
    paymentMethods: [...methods.entries()]
      .map(([method, value]) => ({ method, ...value }))
      .sort((a, b) => b.revenue - a.revenue),
    busiestHours: [...hours.entries()]
      .map(([hour, orders]) => ({ hour, orders }))
      .sort((a, b) => b.orders - a.orders),
  };
}
