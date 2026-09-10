import { describe, expect, it } from "vitest";
import { agentPrice, agentUnitPriceMinor } from "./pricing";

describe("agent pricing", () => {
  it("discounts minor-unit prices with normal rounding", () => {
    expect(agentPrice(10, 8)).toBe(9.2);
    expect(agentPrice(4.99, 8)).toBe(4.59);
    expect(agentPrice(10, 0)).toBe(10);
    expect(agentPrice(10, 50)).toBe(5);
    expect(agentUnitPriceMinor(999, 8)).toBe(919);
  });

  it.each([51, -1, 7.5])("rejects invalid discount %s", (pct) => {
    expect(() => agentPrice(10, pct)).toThrow();
  });
});
