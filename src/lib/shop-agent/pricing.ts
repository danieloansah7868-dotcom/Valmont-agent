/** Pure agent pricing in integer minor units. */
export const MAX_AGENT_DISCOUNT_PERCENT = 50;

function assertDiscountPercent(pct: number): asserts pct is number {
  if (!Number.isInteger(pct) || pct < 0 || pct > MAX_AGENT_DISCOUNT_PERCENT) {
    throw new RangeError("Agent discount must be an integer from 0 to 50.");
  }
}

export function agentUnitPriceMinor(
  unitPriceMinor: number,
  pct: number,
): number {
  assertDiscountPercent(pct);
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new RangeError("Unit price must be a non-negative integer.");
  }
  return Math.round((unitPriceMinor * (100 - pct)) / 100);
}

export function agentPrice(price: number, pct: number): number {
  if (!Number.isFinite(price) || price < 0) {
    throw new RangeError("Price must be a non-negative number.");
  }
  return agentUnitPriceMinor(Math.round(price * 100), pct) / 100;
}
