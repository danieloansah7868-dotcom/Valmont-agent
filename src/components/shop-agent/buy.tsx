"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiMutation, ApiError } from "@/lib/client-api";

/**
 * Stage 7b — the agent's Buy button and its inline panel.
 *
 * The unit price is a SERVER-RENDERED prop (the shop price minus this
 * agent's discount); the panel uses it only to preview what the wallet will
 * be charged and never sends it — the POST carries only item id, quantity
 * and the customer's phone number, and the server recomputes the price from
 * the catalogue (R1). When the wallet cannot cover the order the panel
 * explains top-up instead of offering a button that would only 409.
 */

interface BuyResponse {
  orderId: string;
  status: string;
  total: number;
  balanceAfter: number;
  deliveries: Array<{ status: string }>;
}

function ghs(amount: number): string {
  return `GHS ${amount.toFixed(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "We could not complete that request. Please try again.";
}

export function AgentBuyPanel({
  draftId,
  itemId,
  itemName,
  unitPrice,
  balance,
  businessName,
}: {
  draftId: string;
  itemId: string;
  itemName: string;
  /** The agent's price for ONE unit, rendered by the server. Never posted. */
  unitPrice: number;
  balance: number;
  businessName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // All money math in integer pesewas so float dust can never flip the
  // "can the wallet cover it" decision the wrong way.
  const totalMinor = Math.round(unitPrice * 100) * quantity;
  const balanceMinor = Math.round(balance * 100);
  const total = totalMinor / 100;
  const after = (balanceMinor - totalMinor) / 100;
  const affordable = balanceMinor >= totalMinor;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiMutation<BuyResponse>(
        `/api/a/${encodeURIComponent(draftId)}/orders`,
        { lines: [{ itemId, quantity }], recipientPhone: recipient },
      );
      router.push(
        `/a/${encodeURIComponent(draftId)}/orders/${encodeURIComponent(result.orderId)}`,
      );
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-primary mt-3 w-full text-sm"
        data-testid="agent-buy-open"
        onClick={() => setOpen(true)}
      >
        Order now
      </button>
    );
  }

  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border border-line bg-ivory-50 p-3"
      onSubmit={submit}
      data-testid="agent-buy-panel"
    >
      <div>
        <label className="label" htmlFor={`agent-buy-recipient-${itemId}`}>
          Customer&apos;s number (receives the bundle)
        </label>
        <input
          className="input"
          id={`agent-buy-recipient-${itemId}`}
          data-testid="agent-buy-recipient"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="024 000 0001"
          maxLength={30}
          required
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor={`agent-buy-quantity-${itemId}`}>
          How many (1–10)
        </label>
        <input
          className="input"
          id={`agent-buy-quantity-${itemId}`}
          data-testid="agent-buy-quantity"
          type="number"
          min={1}
          max={10}
          step={1}
          required
          value={quantity}
          onChange={(event) => {
            const next = Math.trunc(Number(event.target.value));
            setQuantity(
              Number.isFinite(next) ? Math.min(10, Math.max(1, next)) : 1,
            );
          }}
        />
      </div>
      <p
        className="text-sm font-semibold text-navy"
        data-testid="agent-buy-total"
      >
        You pay {ghs(total)} for {quantity} × {itemName}
      </p>
      <p className="text-xs text-slate" data-testid="agent-buy-after">
        Wallet after: {ghs(Math.max(after, 0))}
      </p>
      {!affordable ? (
        <p
          className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900"
          data-testid="agent-buy-topup"
          role="status"
        >
          Top up first. Ask {businessName} to add credit.
        </p>
      ) : (
        <button
          type="submit"
          className="btn-primary w-full text-sm"
          disabled={busy}
          data-testid="agent-buy-confirm"
        >
          {busy ? "Placing order…" : "Confirm — pay from wallet"}
        </button>
      )}
      {error && (
        <p
          className="rounded-lg bg-fail-soft px-3 py-2 text-sm text-fail-strong"
          data-testid="agent-buy-error"
          role="alert"
        >
          {error}
        </p>
      )}
    </form>
  );
}
