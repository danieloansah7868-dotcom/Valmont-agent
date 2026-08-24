import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canTransition,
  matchesFilter,
  STATUS_LABELS,
} from "./order-status";

describe("order status workflow", () => {
  it("lets a paid order start preparing, then leave, then arrive", () => {
    expect(canTransition("paid", "preparing")).toBe(true);
    expect(canTransition("preparing", "out_for_delivery")).toBe(true);
    expect(canTransition("out_for_delivery", "delivered")).toBe(true);
    expect(canTransition("delivered", "preparing")).toBe(false);
  });

  it("lets cash-on-delivery skip payment and start preparing", () => {
    expect(canTransition("cod_pending", "preparing")).toBe(true);
    expect(canTransition("pending", "preparing")).toBe(false);
  });

  it("treats a legacy fulfilled order as delivered", () => {
    expect(STATUS_LABELS.fulfilled).toBe("Delivered");
    expect(canTransition("fulfilled", "refunded")).toBe(true);
    expect(matchesFilter("fulfilled", "delivered")).toBe(true);
  });

  it("does not invent transitions out of a cancelled order", () => {
    expect(allowedTransitions("cancelled")).toEqual([]);
  });
});
