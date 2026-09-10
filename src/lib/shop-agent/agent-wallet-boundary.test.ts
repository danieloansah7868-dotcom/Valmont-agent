/**
 * Stage 7b — the "agent_wallet" rail is a namespace of its own.
 *
 * Hard boundary: it is NOT a storefront payment method. It has exactly one
 * definition (AGENT_WALLET_PAYMENT_METHOD in studio/orders.ts), it is not a
 * member of PAYMENT_METHODS, so Studio → Payments can never render it and
 * the public checkout refuses it like any unknown string; the only place
 * the machine word becomes readable is paymentMethodLabel. This file pins
 * the boundary from the constant's side — checkout-side refusals live in
 * checkout-agent-wallet.test.ts, and the production-surface scan (no
 * payment-method selector may mention the rail) lives in
 * src/db/schema-order-ledger.test.ts's sibling assertions.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_WALLET_PAYMENT_METHOD } from "@/lib/studio/agent-wallet";
import { AGENT_WALLET_PAYMENT_METHOD as fromOrders } from "@/lib/studio/orders";
import { AGENT_WALLET_PAYMENT_METHOD as fromAgentOrders } from "./orders";
import { paymentMethodLabel } from "@/lib/shop-admin/order-view";
import {
  isPaymentMethodId,
  PAYMENT_METHODS,
} from "@/lib/studio/site-brief/schema";

describe("AgentWalletBoundary — one constant, one spelling", () => {
  it("the definition and every re-export are the same string", () => {
    expect(AGENT_WALLET_PAYMENT_METHOD).toBe("agent_wallet");
    expect(fromOrders).toBe(AGENT_WALLET_PAYMENT_METHOD);
    expect(fromAgentOrders).toBe(AGENT_WALLET_PAYMENT_METHOD);
  });

  it("agent wallet is never a storefront payment method", () => {
    expect(isPaymentMethodId(AGENT_WALLET_PAYMENT_METHOD)).toBe(false);
    expect(
      PAYMENT_METHODS.some(
        (method) => (method.id as string) === AGENT_WALLET_PAYMENT_METHOD,
      ),
    ).toBe(false);
    // And conversely every real storefront method still validates — the
    // boundary narrows, it does not break the existing rails.
    for (const method of PAYMENT_METHODS) {
      expect(isPaymentMethodId(method.id)).toBe(true);
    }
  });

  it("the readable label exists only through paymentMethodLabel", () => {
    expect(paymentMethodLabel(AGENT_WALLET_PAYMENT_METHOD)).toBe(
      "Agent wallet",
    );
    // It collides with no real method's label…
    expect(
      PAYMENT_METHODS.some(
        (method) => (method.label as string) === "Agent wallet",
      ),
    ).toBe(false);
    // …and known methods keep their own labels (raw fallback for unknowns).
    expect(paymentMethodLabel("momo")).toBe("Mobile Money");
    expect(paymentMethodLabel("yet_another_method")).toBe("yet_another_method");
  });

  it("no payment-method selector in the shipped UI can offer the wallet rail", () => {
    // Every file that renders PAYMENT_METHODS choices (storefront checkout,
    // Studio payments settings, the wizard) must source them from
    // PAYMENT_METHODS: as long as none of them names the rail, there is
    // literally no <option> it could appear in. This trips the moment
    // anyone hand-adds it.
    const roots = [
      path.resolve(__dirname, "..", "..", "app"),
      path.resolve(__dirname, "..", "..", "components"),
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry) || entry.includes(".test.")) continue;
        const source = readFileSync(full, "utf8");
        // Code-shaped leaks only (prose comments naming the rail are fine —
        // deleting help text is forbidden). A leak is: a raw comparison
        // against the literal instead of the shared constant, or the rail
        // handed to a form/select as a value.
        if (/===\s*"agent_wallet"/.test(source)) offenders.push(full);
        if (/value="agent_wallet"/.test(source)) offenders.push(full);
        if (/value=\{"agent_wallet"\}/.test(source)) offenders.push(full);
        if (/<option[^>]*AGENT_WALLET/.test(source)) offenders.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
