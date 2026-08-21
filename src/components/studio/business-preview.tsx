"use client";

import { useMemo, useState } from "react";
import {
  computeBriefCompleteness,
  displayValue,
} from "@/lib/studio/site-brief/readiness";
import type { CatalogItem, SiteBriefV1 } from "@/lib/studio/site-brief/schema";
import { PAYMENT_METHODS } from "@/lib/studio/site-brief/schema";
import { getTheme } from "@/lib/studio/themes";
import { getTemplate } from "@/lib/studio/templates";
import { isHttpsSafeUrl } from "@/lib/studio/site-brief/schema";
import { computeTotals, formatMoney } from "@/lib/studio/valmont-pay";

/**
 * A preview of the future website. It shows only what the owner typed: no
 * invented prices, testimonials, delivery promises or payment claims. When the
 * shop has payments switched on and at least one priced item, the preview also
 * becomes a working basket and checkout — the same flow a real customer will
 * use — so the owner can try it before going live.
 *
 * `draftId` is required to submit a real order. The wizard passes it so the
 * owner's preview can place a genuine test order.
 */
export function BusinessPreview({
  brief,
  draftId,
}: {
  brief: Partial<SiteBriefV1>;
  draftId?: string;
}) {
  const completeness = computeBriefCompleteness(brief);
  const theme = brief.selectedTheme ? getTheme(brief.selectedTheme) : undefined;
  const template = brief.selectedTemplate
    ? getTemplate(brief.selectedTemplate)
    : undefined;

  const name = displayValue(brief.businessName);
  const tagline = displayValue(brief.tagline);
  const description = displayValue(brief.description);
  const address = displayValue(brief.address);
  const hours = displayValue(brief.hours);

  const mapsLink =
    brief.mapsLink && isHttpsSafeUrl(brief.mapsLink) ? brief.mapsLink : null;

  const accent = theme?.tokens.colors.primary ?? "#0b2545";
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

  return (
    <section
      aria-label="Website preview"
      data-testid="business-preview"
      className="overflow-hidden rounded-xl border border-line bg-white"
    >
      <header className="p-4" style={{ borderTop: `4px solid ${accent}` }}>
        <p className="text-[11px] uppercase tracking-wide text-slate-500">
          Preview{template ? ` · ${template.label}` : ""}
          {theme ? ` · ${theme.label}` : ""}
        </p>
        <div className="mt-1 flex items-start gap-3">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo.dataUrl}
              alt=""
              data-testid="preview-logo"
              className="h-14 w-14 shrink-0 rounded-md object-contain ring-1 ring-line"
            />
          ) : null}
          <div className="min-w-0">
            <h2
              className={`text-lg font-bold ${name.isPlaceholder ? "text-slate-400 italic" : "text-navy"}`}
            >
              {name.text}
            </h2>
            <p
              className={`text-sm ${tagline.isPlaceholder ? "text-slate-400 italic" : "text-slate"}`}
            >
              {tagline.text}
            </p>
          </div>
        </div>
      </header>

      <div className="border-t border-line p-4 text-sm">
        <p
          className={
            description.isPlaceholder ? "text-slate-400 italic" : "text-slate"
          }
        >
          {description.text}
        </p>

        <dl className="mt-3 grid gap-2">
          <PreviewRow
            label="Phone"
            value={brief.phone}
            href={brief.phone ? `tel:${brief.phone}` : undefined}
          />
          <PreviewRow
            label="WhatsApp"
            value={brief.whatsapp}
            href={
              brief.whatsapp
                ? `https://wa.me/${brief.whatsapp.replace(/\D/g, "")}`
                : undefined
            }
          />
          <PreviewRow
            label="Email"
            value={brief.email}
            href={brief.email ? `mailto:${brief.email}` : undefined}
          />
          <div>
            <dt className="inline font-semibold">Address: </dt>
            <dd
              className={`inline ${address.isPlaceholder ? "text-slate-400 italic" : ""}`}
            >
              {address.text}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Opening hours: </dt>
            <dd
              className={`inline ${hours.isPlaceholder ? "text-slate-400 italic" : ""}`}
            >
              {hours.text}
            </dd>
          </div>
        </dl>

        {mapsLink && (
          <a
            href={mapsLink}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="mt-2 inline-block break-all text-brandblue underline"
          >
            View on the map
          </a>
        )}

        {(brief.services?.length ?? 0) > 0 && (
          <PreviewList title="Services" items={brief.services!} />
        )}

        {shopOpen && pricedItems.length > 0 ? (
          <Shop
            items={items}
            currency={currency}
            payments={payments!}
            draftId={draftId}
            canCheckout={canCheckout}
          />
        ) : (
          (items.length > 0 || (brief.products?.length ?? 0) > 0) && (
            <PreviewList
              title="Products"
              items={
                items.length > 0
                  ? items.map((item) => item.name)
                  : brief.products!.map((product) => product.name)
              }
            />
          )
        )}

        {(brief.serviceAreas?.length ?? 0) > 0 && (
          <PreviewList title="Areas served" items={brief.serviceAreas!} />
        )}

        {photos.length > 0 && (
          <div className="mt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Photos
            </h3>
            <div
              data-testid="preview-photos"
              className="mt-1 grid grid-cols-2 gap-1"
            >
              {photos.map((photo, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${photo.fileName}-${i}`}
                  src={photo.dataUrl}
                  alt={photo.fileName}
                  className="aspect-[4/3] w-full rounded-md object-cover"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="border-t border-line bg-slate-50 p-3 text-xs text-slate-600">
        Brief completeness: {completeness.score}% ·{" "}
        {completeness.missingRequired.length} required item
        {completeness.missingRequired.length === 1 ? "" : "s"} still needed.
        {shopOpen
          ? " This shop can take orders."
          : " This is a plan, not a live website — nothing here can take orders or payments."}
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shop: basket + inline checkout
// ---------------------------------------------------------------------------

interface CheckoutResponse {
  orderId: string;
  accessCode: string;
  paymentLink: string | null;
  status: string;
}

function Shop({
  items,
  currency,
  payments,
  draftId,
  canCheckout,
}: {
  items: CatalogItem[];
  currency: string;
  payments: NonNullable<SiteBriefV1["payments"]>;
  draftId?: string;
  canCheckout: boolean;
}) {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [addressText, setAddressText] = useState("");
  const [method, setMethod] = useState<string>(payments.methods[0] ?? "");
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

  function setQty(id: string, quantity: number) {
    setCart((current) => ({ ...current, [id]: Math.max(0, quantity) }));
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

  if (placed) {
    return (
      <div
        data-testid="order-success"
        className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4"
      >
        <h3 className="text-sm font-semibold text-green-900">Order placed!</h3>
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
            Your order has been recorded. You will get payment or delivery
            instructions from the business.
          </p>
        )}
        <a
          href={`/orders/${placed.orderId}/confirmed`}
          className="mt-3 block text-sm underline"
        >
          View order details
        </a>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Shop
      </h3>
      <ul className="mt-2 grid gap-2">
        {priced.map((item) => {
          const qty = cart[item.id] ?? 0;
          return (
            <li
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line p-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{item.name}</p>
                <p className="text-xs text-slate-600">
                  {formatMoney(item.price!, currency)}
                </p>
              </div>
              {qty === 0 ? (
                <button
                  type="button"
                  onClick={() => setQty(item.id, 1)}
                  className="btn-secondary min-h-9 px-3 text-sm"
                  data-testid={`add-${item.id}`}
                >
                  Add
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Remove one ${item.name}`}
                    onClick={() => setQty(item.id, qty - 1)}
                    className="min-h-9 w-9 rounded-md border border-line text-lg"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm">{qty}</span>
                  <button
                    type="button"
                    aria-label={`Add one ${item.name}`}
                    onClick={() => setQty(item.id, qty + 1)}
                    className="min-h-9 w-9 rounded-md border border-line text-lg"
                  >
                    +
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {itemCount > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-slate-50 p-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-semibold"
            data-testid="cart-bar"
          >
            <span>
              Basket · {itemCount} item{itemCount === 1 ? "" : "s"}
            </span>
            <span>{formatMoney(totals.total, currency)}</span>
          </button>

          {open && (
            <div className="mt-3 border-t border-line pt-3">
              <ul className="grid gap-1 text-sm">
                {lines.map((line) => (
                  <li key={line.item.id} className="flex justify-between gap-4">
                    <span>
                      {line.item.name} × {line.quantity}
                    </span>
                    <span>
                      {formatMoney(line.price * line.quantity, currency)}
                    </span>
                  </li>
                ))}
                {totals.deliveryFee > 0 && (
                  <li className="flex justify-between gap-4">
                    <span>Delivery</span>
                    <span>{formatMoney(totals.deliveryFee, currency)}</span>
                  </li>
                )}
                <li className="flex justify-between gap-4 border-t border-line pt-1 font-semibold">
                  <span>Total</span>
                  <span>{formatMoney(totals.total, currency)}</span>
                </li>
              </ul>

              {!canCheckout ? (
                <p className="mt-3 text-xs text-slate-600">
                  Checkout runs on the saved draft. Save this draft to place a
                  test order.
                </p>
              ) : !checkingOut ? (
                <button
                  type="button"
                  onClick={() => setCheckingOut(true)}
                  className="btn-primary mt-3 w-full"
                  data-testid="start-checkout"
                >
                  Checkout
                </button>
              ) : (
                <form
                  className="mt-3 grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void placeOrder();
                  }}
                >
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
                    {payments.methods.map((methodId) => {
                      const meta = PAYMENT_METHODS.find(
                        (m) => m.id === methodId,
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
            </div>
          )}
        </div>
      )}
    </div>
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

function PreviewRow({
  label,
  value,
  href,
}: {
  label: string;
  value?: string;
  href?: string;
}) {
  const shown = displayValue(value);
  return (
    <div>
      <dt className="inline font-semibold">{label}: </dt>
      <dd className="inline">
        {href && !shown.isPlaceholder ? (
          <a href={href} rel="noopener noreferrer" className="underline">
            {shown.text}
          </a>
        ) : (
          <span className={shown.isPlaceholder ? "text-slate-400 italic" : ""}>
            {shown.text}
          </span>
        )}
      </dd>
    </div>
  );
}

function PreviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
