"use client";

import { useEffect, useMemo, useState } from "react";
import {
  customerFacingPaymentMethods,
  isHttpsSafeUrl,
  PAYMENT_METHODS,
  type CatalogItem,
  type SiteBriefV1,
} from "@/lib/studio/site-brief/schema";
import { getTheme } from "@/lib/studio/themes";
import { computeTotals, formatMoney } from "@/lib/studio/valmont-pay";

interface CheckoutResponse {
  orderId: string;
  accessCode: string;
  paymentLink: string | null;
  status: string;
}

export function Storefront({
  brief,
  draftId,
  variant = "public",
}: {
  brief: Partial<SiteBriefV1>;
  draftId?: string;
  variant?: "public" | "preview";
}) {
  const theme = brief.selectedTheme ? getTheme(brief.selectedTheme) : undefined;
  const primary = theme?.tokens.colors.primary ?? "#0A1F44";
  const accent = theme?.tokens.colors.accent ?? "#E8822B";
  const surface = theme?.tokens.colors.surface ?? "#F8F6F0";
  const text = theme?.tokens.colors.text ?? "#0A1F44";
  const name = brief.businessName?.trim() || "Your business";
  const tagline = brief.tagline?.trim() || "";
  const description = brief.description?.trim() || "";
  const logo = brief.assets?.logo ?? null;
  const photos = brief.assets?.photos ?? [];
  const currency = brief.currency ?? "GHS";
  const payments = brief.payments;
  const shopOpen = Boolean(payments?.enabled);
  const items = useMemo<CatalogItem[]>(() => brief.items ?? [], [brief.items]);
  const pricedItems = useMemo(
    () => items.filter((item) => item.price !== undefined),
    [items],
  );
  const canCheckout = shopOpen && pricedItems.length > 0 && Boolean(draftId);
  const mapsLink =
    brief.mapsLink && isHttpsSafeUrl(brief.mapsLink) ? brief.mapsLink : null;
  const cta = brief.primaryCallToAction?.trim() || "Order now";

  return (
    <div
      data-testid={variant === "preview" ? undefined : "public-storefront"}
      className={
        variant === "public"
          ? "min-h-dvh"
          : "overflow-hidden rounded-xl border border-line"
      }
      style={
        {
          background: surface,
          color: text,
          "--shop-primary": primary,
          "--shop-accent": accent,
        } as React.CSSProperties
      }
    >
      <header
        className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6"
        style={{ background: primary, color: "#F8F6F0" }}
      >
        <div className="flex min-w-0 items-center gap-3">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo.dataUrl}
              alt=""
              data-testid={variant === "preview" ? "preview-logo" : "site-logo"}
              className="size-11 rounded-lg bg-white object-contain"
            />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-base font-bold">{name}</p>
            {tagline ? (
              <p className="truncate text-xs text-white/75">{tagline}</p>
            ) : null}
          </div>
        </div>
        {shopOpen && pricedItems.length > 0 ? (
          <a
            href="#menu"
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-bold"
            style={{ background: accent, color: primary }}
          >
            {cta}
          </a>
        ) : null}
      </header>

      <section className="px-4 py-8 sm:px-6 sm:py-12">
        <div className="mx-auto grid max-w-3xl gap-6">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] uppercase opacity-70">
              {brief.category === "restaurant" ? "Restaurant" : "Welcome"}
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              {name}
            </h1>
            {tagline ? (
              <p className="mt-2 text-lg" style={{ color: accent }}>
                {tagline}
              </p>
            ) : variant === "preview" ? (
              <p className="mt-2 text-sm italic opacity-50">Not provided yet</p>
            ) : null}
            {description ? (
              <p className="mt-4 text-sm leading-6 opacity-90">{description}</p>
            ) : variant === "preview" ? (
              <p className="mt-4 text-sm italic opacity-50">Not provided yet</p>
            ) : null}
            {shopOpen && pricedItems.length > 0 ? (
              <a
                href="#menu"
                className="mt-6 inline-flex min-h-11 items-center rounded-xl px-5 text-base font-bold shadow-sm"
                style={{ background: accent, color: primary }}
              >
                {cta}
              </a>
            ) : null}
          </div>

          {photos.length > 0 && (
            <div
              data-testid={
                variant === "preview" ? "preview-photos" : "site-photos"
              }
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
            >
              {photos.map((photo, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${photo.fileName}-${i}`}
                  src={photo.dataUrl}
                  alt={photo.fileName}
                  className="aspect-[4/3] w-full rounded-xl object-cover"
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {shopOpen && pricedItems.length > 0 ? (
        <Shop
          items={items}
          currency={currency}
          payments={payments!}
          draftId={draftId}
          canCheckout={canCheckout}
          accent={accent}
          primary={primary}
          checkoutNote={payments?.checkoutNote}
        />
      ) : items.length > 0 ? (
        <section className="mx-auto max-w-3xl px-4 pb-10 sm:px-6">
          <h2 className="text-lg font-bold">Menu</h2>
          <ul className="mt-3 grid gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-black/10 p-3"
              >
                {item.name}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <h2 className="text-lg font-bold">Find us</h2>
        <dl className="mt-3 grid gap-2 text-sm">
          {brief.phone && (
            <div>
              <dt className="font-semibold">Phone</dt>
              <dd>
                <a href={`tel:${brief.phone}`} className="underline">
                  {brief.phone}
                </a>
              </dd>
            </div>
          )}
          {brief.whatsapp && (
            <div>
              <dt className="font-semibold">WhatsApp</dt>
              <dd>
                <a
                  href={`https://wa.me/${brief.whatsapp.replace(/\D/g, "")}`}
                  className="underline"
                  rel="noopener noreferrer"
                >
                  {brief.whatsapp}
                </a>
              </dd>
            </div>
          )}
          {brief.email && (
            <div>
              <dt className="font-semibold">Email</dt>
              <dd>
                <a href={`mailto:${brief.email}`} className="underline">
                  {brief.email}
                </a>
              </dd>
            </div>
          )}
          {brief.address && (
            <div>
              <dt className="font-semibold">Address</dt>
              <dd>
                {brief.address}
                {mapsLink ? (
                  <>
                    {" "}
                    <a
                      href={mapsLink}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="underline"
                    >
                      View on the map
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          )}
          {brief.hours && (
            <div>
              <dt className="font-semibold">Opening hours</dt>
              <dd>{brief.hours}</dd>
            </div>
          )}
        </dl>
      </section>

      {variant === "public" && (
        <footer className="border-t border-black/10 px-4 py-6 text-center text-xs opacity-60">
          Website by Valmont
        </footer>
      )}
    </div>
  );
}

function Shop({
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
  const [email, setEmail] = useState("");
  const [addressText, setAddressText] = useState("");
  const methods = customerFacingPaymentMethods(payments.methods);
  const [method, setMethod] = useState<string>(methods[0] ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<CheckoutResponse | null>(null);

  const priced = useMemo(
    () => items.filter((item) => item.price !== undefined),
    [items],
  );
  const byId = useMemo(
    () => new Map(priced.map((item) => [item.id, item])),
    [priced],
  );
  const deliveryEnabled = payments.delivery.enabled;
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
          enabled: deliveryEnabled,
          fee: payments.delivery.fee,
          minimumOrder: payments.delivery.minimumOrder,
          freeDeliveryAbove: payments.delivery.freeDeliveryAbove,
        },
      ),
    [lines, deliveryEnabled, payments.delivery],
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
          customerPhone: phone,
          customerEmail: email || undefined,
          customerAddress: addressText || undefined,
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

  return (
    <section id="menu" className="mx-auto max-w-3xl px-4 pb-10 sm:px-6">
      <div className="flex items-end justify-between gap-3">
        <h2 className="text-lg font-bold">Menu</h2>
        {itemCount > 0 && (
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            data-testid="cart-bar"
            className="relative rounded-full px-3 py-1.5 text-sm font-bold"
            style={{ background: accent, color: primary }}
          >
            Basket · {itemCount}
            <span className="sr-only"> items</span>
          </button>
        )}
      </div>

      <ul className="mt-4 grid gap-3">
        {priced.map((item) => {
          const qty = cart[item.id] ?? 0;
          return (
            <li
              key={item.id}
              className="flex gap-3 rounded-2xl border border-black/8 bg-white p-3 shadow-sm"
            >
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.image}
                  alt=""
                  className="size-20 shrink-0 rounded-xl object-cover"
                />
              ) : (
                <span
                  className="flex size-20 shrink-0 items-center justify-center rounded-xl text-xs font-bold"
                  style={{ background: `${accent}22`, color: accent }}
                  aria-hidden="true"
                >
                  {item.name.slice(0, 1)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold">{item.name}</p>
                {item.description ? (
                  <p className="mt-0.5 line-clamp-2 text-xs opacity-70">
                    {item.description}
                  </p>
                ) : null}
                <p className="mt-1 text-sm font-bold" style={{ color: accent }}>
                  {formatMoney(item.price!, currency)}
                </p>
              </div>
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
                        {line.item.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={line.item.image}
                            alt=""
                            className="size-12 rounded-lg object-cover"
                          />
                        ) : null}
                        <span className="min-w-0 flex-1">
                          {line.item.name} × {line.quantity}
                        </span>
                        <span className="font-semibold">
                          {formatMoney(line.price * line.quantity, currency)}
                        </span>
                      </li>
                    ))}
                    {totals.deliveryFee > 0 && (
                      <li className="flex justify-between text-sm">
                        <span>Delivery</span>
                        <span>{formatMoney(totals.deliveryFee, currency)}</span>
                      </li>
                    )}
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
                      <Field
                        label="Your name"
                        value={name}
                        onChange={setName}
                        required
                      />
                      <Field
                        label="Phone number"
                        value={phone}
                        onChange={setPhone}
                        required
                        type="tel"
                      />
                      <Field
                        label="Email (optional)"
                        value={email}
                        onChange={setEmail}
                        type="email"
                      />
                      {deliveryEnabled && (
                        <Field
                          label="Delivery address"
                          value={addressText}
                          onChange={setAddressText}
                          required
                        />
                      )}
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
                      <Field
                        label="Note for the business (optional)"
                        value={note}
                        onChange={setNote}
                      />
                      {error && (
                        <p role="alert" className="text-sm text-red-700">
                          {error}
                        </p>
                      )}
                      <button
                        type="submit"
                        disabled={busy || !method}
                        className="btn-primary mt-1 w-full"
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

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-sm font-semibold">{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-line px-3 py-2 text-base"
      />
    </label>
  );
}
