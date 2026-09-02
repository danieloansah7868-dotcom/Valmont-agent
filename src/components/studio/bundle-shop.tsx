"use client";

import { useEffect, useMemo, useState } from "react";
import {
  customerFacingPaymentMethods,
  PAYMENT_METHODS,
  type CatalogItem,
  type SiteBriefV1,
} from "@/lib/studio/site-brief/schema";
import { computeTotals, formatMoney } from "@/lib/studio/money";
import {
  BUNDLE_NETWORKS,
  type BundleNetworkId,
  groupBundlesByNetwork,
  formatDataMb,
  bundleNetworkLabel,
  bundleNetworkColors,
  getBundleNetwork,
  normalizeGhanaMobile,
  checkRecipientNetworkMatch,
  validateGhanaMobile,
} from "@/lib/studio/bundles";

interface CheckoutResponse {
  orderId: string;
  accessCode: string;
  paymentLink: string | null;
  status: string;
}

export function BundleShop({
  items,
  currency,
  payments,
  draftId,
  canCheckout,
  accent,
  primary,
  checkoutNote,
}: {
  items: CatalogItem[];
  currency: string;
  payments: NonNullable<SiteBriefV1["payments"]>;
  draftId?: string;
  canCheckout: boolean;
  accent: string;
  primary: string;
  checkoutNote?: string;
}) {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const methods = customerFacingPaymentMethods(payments.methods);
  const [method, setMethod] = useState<string>(methods[0] ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<CheckoutResponse | null>(null);

  const grouped = useMemo(() => groupBundlesByNetwork(items), [items]);
  const [activeNetwork, setActiveNetwork] = useState<BundleNetworkId>("mtn");

  useEffect(() => {
    if (grouped[activeNetwork]?.length > 0) return;
    const firstWith = (Object.keys(grouped) as BundleNetworkId[]).find(
      (k) => grouped[k].length > 0,
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (firstWith) setActiveNetwork(firstWith);
  }, [grouped, activeNetwork]);

  const priced = useMemo(
    () => items.filter((item) => item.price !== undefined),
    [items],
  );
  const byId = useMemo(
    () => new Map(priced.map((item) => [item.id, item])),
    [priced],
  );
  const lines = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, quantity]) => quantity > 0)
        .map(([id, quantity]) => {
          const item = byId.get(id)!;
          return { price: item.price!, quantity, item };
        }),
    [cart, byId],
  );
  const totals = useMemo(
    () =>
      computeTotals(
        lines.map((line) => ({ price: line.price, quantity: line.quantity })),
        {
          enabled: false,
          fee: 0,
          minimumOrder: 0,
        },
      ),
    [lines],
  );
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  useEffect(() => {
    document.body.style.overflow = cartOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [cartOpen]);

  function setQty(id: string, quantity: number) {
    setCart((current) => ({ ...current, [id]: Math.max(0, quantity) }));
    if (quantity > 0) setCartOpen(true);
  }

  async function placeOrder() {
    if (!draftId) return;
    const phoneErr = validateGhanaMobile(phone);
    if (phoneErr) {
      setPhoneError(phoneErr);
      setError(phoneErr);
      return;
    }
    setPhoneError(null);
    const normalizedPhone = normalizeGhanaMobile(phone) ?? phone;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/studio/drafts/${draftId}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: lines.map((line) => ({
            itemId: line.item.id,
            quantity: line.quantity,
          })),
          customerName: name,
          customerPhone: normalizedPhone,
          customerEmail: email || undefined,
          paymentMethod: method,
          note: note || undefined,
        }),
      });
      const data = (await response.json()) as CheckoutResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not place the order.");
      }
      setPlaced(data);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  const networkWarnings = useMemo(() => {
    if (!phone.trim()) return [];
    if (validateGhanaMobile(phone)) return [];
    const warnings: string[] = [];
    for (const line of lines) {
      const net = getBundleNetwork(line.item);
      if (!net) continue;
      const check = checkRecipientNetworkMatch(phone, net);
      if (!check.matches && check.warning) {
        warnings.push(check.warning);
      }
    }
    return [...new Set(warnings)];
  }, [phone, lines]);

  const activeBundles = grouped[activeNetwork] ?? [];

  return (
    <section id="menu" className="mx-auto max-w-3xl px-4 pb-10 sm:px-6">
      <div className="flex items-end justify-between gap-3">
        <h2 className="text-lg font-bold">Data Bundles</h2>
        {itemCount > 0 && (
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            data-testid="cart-bar"
            className="relative rounded-full px-3 py-1.5 text-sm font-bold"
            style={{ background: accent, color: primary }}
          >
            Basket · {itemCount}
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {BUNDLE_NETWORKS.map((net) => {
          const has = grouped[net.id as BundleNetworkId]?.length > 0;
          if (!has) return null;
          const isActive = activeNetwork === net.id;
          const colors = bundleNetworkColors(net.id);
          return (
            <button
              key={net.id}
              type="button"
              onClick={() => setActiveNetwork(net.id as BundleNetworkId)}
              className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                isActive ? "shadow" : "opacity-80"
              }`}
              style={{
                background: isActive ? colors.bg : `${colors.bg}22`,
                color: isActive ? colors.fg : primary,
                border: `1px solid ${colors.bg}`,
              }}
              data-testid={`network-tab-${net.id}`}
            >
              {net.label}
            </button>
          );
        })}
      </div>

      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {activeBundles.map((item) => {
          const qty = cart[item.id] ?? 0;
          const sizeLabel = item.bundle?.dataMb
            ? formatDataMb(item.bundle.dataMb)
            : item.name;
          const validity = item.bundle?.validity ?? "";
          const networkId = getBundleNetwork(item) ?? activeNetwork;
          const colors = bundleNetworkColors(networkId);
          return (
            <li
              key={item.id}
              className="flex flex-col gap-2 rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: colors.bg, color: colors.fg }}
                >
                  {bundleNetworkLabel(networkId)}
                </span>
                {validity && (
                  <span className="text-xs opacity-60">{validity}</span>
                )}
              </div>
              <p className="text-lg font-bold">{sizeLabel}</p>
              {item.description &&
              item.description !== `${sizeLabel} - ${validity}` ? (
                <p className="text-xs opacity-70">{item.description}</p>
              ) : null}
              <p className="text-sm font-bold" style={{ color: accent }}>
                {formatMoney(item.price!, currency)}
              </p>
              {qty === 0 ? (
                <button
                  type="button"
                  onClick={() => setQty(item.id, 1)}
                  className="self-center rounded-xl px-3 py-2 text-sm font-bold"
                  style={{ background: accent, color: primary }}
                  data-testid={`add-${item.id}`}
                >
                  Add
                </button>
              ) : (
                <div className="flex items-center gap-2 self-center">
                  <button
                    type="button"
                    aria-label={`Remove one ${item.name}`}
                    onClick={() => setQty(item.id, qty - 1)}
                    className="min-h-9 w-9 rounded-lg border border-black/10 text-lg"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm font-bold">
                    {qty}
                  </span>
                  <button
                    type="button"
                    aria-label={`Add one ${item.name}`}
                    onClick={() => setQty(item.id, qty + 1)}
                    className="min-h-9 w-9 rounded-lg border border-black/10 text-lg"
                  >
                    +
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {cartOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-navy/50"
            aria-label="Close basket"
            onClick={() => setCartOpen(false)}
          />
          <aside
            className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-2xl transition-transform"
            role="dialog"
            aria-label="Basket"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h3 className="text-base font-bold text-navy">
                Basket · {itemCount} item{itemCount === 1 ? "" : "s"}
              </h3>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="btn-quiet px-3"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {placed ? (
                <div
                  data-testid="order-success"
                  className="rounded-xl border border-green-300 bg-green-50 p-4"
                >
                  <h3 className="text-sm font-semibold text-green-900">
                    Order placed!
                  </h3>
                  {placed.paymentLink ? (
                    <>
                      <p className="mt-1 text-sm text-green-800">
                        Continue to pay {formatMoney(totals.total, currency)}.
                      </p>
                      <a
                        href={placed.paymentLink}
                        className="btn-primary mt-3 inline-flex"
                        data-testid="order-pay-link"
                      >
                        Pay now
                      </a>
                    </>
                  ) : (
                    <p className="mt-1 text-sm text-green-800">
                      Your order has been recorded. You will get payment or
                      delivery instructions from the business.
                    </p>
                  )}
                  <a
                    href={`/orders/${placed.orderId}/confirmed`}
                    className="mt-3 block text-sm underline"
                  >
                    View order details
                  </a>
                </div>
              ) : itemCount === 0 ? (
                <p className="text-sm text-slate-600">
                  Your basket is empty. Add something from the menu.
                </p>
              ) : (
                <>
                  <ul className="grid gap-3">
                    {lines.map((line) => (
                      <li
                        key={line.item.id}
                        className="flex items-center gap-3 text-sm"
                      >
                        <span className="min-w-0 flex-1">
                          {line.item.name} × {line.quantity}
                        </span>
                        <span className="font-semibold">
                          {formatMoney(line.price * line.quantity, currency)}
                        </span>
                      </li>
                    ))}
                    <li className="flex justify-between border-t border-line pt-2 text-base font-bold">
                      <span>Total</span>
                      <span style={{ color: accent }}>
                        {formatMoney(totals.total, currency)}
                      </span>
                    </li>
                  </ul>

                  {!canCheckout ? (
                    <p className="mt-4 text-xs text-slate-600">
                      Checkout runs on the saved draft. Save this draft to place
                      a test order.
                    </p>
                  ) : !checkingOut ? (
                    <button
                      type="button"
                      onClick={() => setCheckingOut(true)}
                      className="btn-primary mt-4 w-full"
                      data-testid="start-checkout"
                    >
                      Checkout
                    </button>
                  ) : (
                    <form
                      className="mt-4 grid gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void placeOrder();
                      }}
                    >
                      {checkoutNote ? (
                        <p className="rounded-lg bg-ivory-100 p-2 text-xs text-slate-700">
                          {checkoutNote}
                        </p>
                      ) : null}
                      <label className="grid gap-1">
                        <span className="text-sm font-semibold">Your name</span>
                        <input
                          type="text"
                          value={name}
                          required
                          onChange={(e) => setName(e.target.value)}
                          className="w-full rounded-lg border border-line px-3 py-2 text-base"
                        />
                      </label>
                      <div className="grid gap-1">
                        <label className="grid gap-1">
                          <span className="text-sm font-semibold">
                            Phone number (Ghana mobile)
                          </span>
                          <input
                            type="tel"
                            value={phone}
                            placeholder="0240000001"
                            required
                            onChange={(e) => {
                              setPhone(e.target.value);
                              if (phoneError) setPhoneError(null);
                            }}
                            onBlur={() => {
                              const err = validateGhanaMobile(phone);
                              setPhoneError(err);
                            }}
                            className={`w-full rounded-lg border px-3 py-2 text-base ${
                              phoneError ? "border-red-500" : "border-line"
                            }`}
                            data-testid="checkout-phone"
                          />
                        </label>
                        {phoneError ? (
                          <p className="text-xs text-red-700" role="alert">
                            {phoneError}
                          </p>
                        ) : (
                          <p className="text-xs text-slate-500">
                            Ghana mobiles only: 02x or 05x, saved as 0240000001
                          </p>
                        )}
                      </div>
                      {networkWarnings.length > 0 && (
                        <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
                          {networkWarnings.map((w, i) => (
                            <p key={i}>{w}</p>
                          ))}
                        </div>
                      )}
                      <label className="grid gap-1">
                        <span className="text-sm font-semibold">
                          Email (optional)
                        </span>
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="w-full rounded-lg border border-line px-3 py-2 text-base"
                        />
                      </label>
                      <fieldset className="grid gap-1">
                        <legend className="text-sm font-semibold">
                          How would you like to pay?
                        </legend>
                        {methods.map((methodId) => {
                          const meta = PAYMENT_METHODS.find(
                            (entry) => entry.id === methodId,
                          );
                          return (
                            <label
                              key={methodId}
                              className="flex items-center gap-2 text-sm"
                            >
                              <input
                                type="radio"
                                name="paymentMethod"
                                value={methodId}
                                checked={method === methodId}
                                onChange={() => setMethod(methodId)}
                              />
                              <span>{meta?.label ?? methodId}</span>
                            </label>
                          );
                        })}
                      </fieldset>
                      <label className="grid gap-1">
                        <span className="text-sm font-semibold">
                          Note for the business (optional)
                        </span>
                        <input
                          type="text"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          className="w-full rounded-lg border border-line px-3 py-2 text-base"
                        />
                      </label>
                      {error && (
                        <p role="alert" className="text-sm text-red-700">
                          {error}
                        </p>
                      )}
                      <button
                        type="submit"
                        disabled={busy || !method}
                        className="btn-primary mt-1 w-full disabled:opacity-60"
                        data-testid="place-order"
                      >
                        {busy
                          ? "Placing order…"
                          : `Place order · ${formatMoney(totals.total, currency)}`}
                      </button>
                    </form>
                  )}
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
