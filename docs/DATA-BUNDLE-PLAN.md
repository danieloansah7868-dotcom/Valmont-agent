# Data-Bundle Plan — Ghana Telecom Reseller for Valmont Studio

> Owner-facing: lets a shop sell MTN, Telecel, AirtelTigo and MTN Up2U data bundles alongside physical products. No real money moves without Valmont Pay or Mobile Money; fulfillment is manual in Stage 2, provider API in Stage 3.

## Goal

Small businesses in Ghana already resell data. Valmont Studio should let them list bundles, group by network, collect the recipient phone at checkout, and track delivery as a fulfillment step — reusing the existing basket, order, and notification pipeline.

## Stages

### Stage 1 — Foundation (schema + validation)

- `src/lib/studio/data-bundles.ts` — networks, volume grammar, Zod schema, parsing, formatting, helpers.
- Extend `SiteBriefV1` with `dataBundles: DataBundle[]` and `features.dataBundles: boolean` (default off).
- `OrderLine` gets optional `bundleMeta` so an order snapshot keeps network/volume/validity.
- Backup v2 already carries the brief, so bundles are backed up for free.
- Tests: schema validation, parsing, formatting, backward compat (old drafts have no bundles).

Status: **implemented in this branch as prerequisite for Stage 2**.

### Stage 2 — Merchant UX + Storefront (this stage)

Merchant wizard (Studio → Draft):

- New fieldset in Step 4 "Data bundles" — visible when `online-shop` and feature on, or always with an enable toggle.
- Feature toggle `features.dataBundles` in Step 5 alongside customer accounts.
- UI: network select (MTN, Telecel, AirtelTigo, MTN Up2U), volume (e.g. 1GB, 2GB, 5GB, 10GB, custom), validity days (1,3,7,30, etc.), price (GHS), name auto-generated but editable, active toggle.
- List, edit, delete, reorder. Live preview of parsed bundles.
- Validation: price ≥0, volume grammar, validity 1–365, network enum.
- Completeness: data bundles count as offerings (same as services/products/items).

Public storefront (`/s/[id]` and preview):

- New "Data Bundles" section, grouped by network with colored badges (MTN yellow, Telecel red, AirtelTigo blue, Up2U orange).
- Each bundle shows volume, validity, price, network badge.
- Add to basket reuses existing cart; cart badge shows total.
- Checkout: when basket contains any bundle, an extra "Recipient phone number(s)" field is required. For multiple bundles, one phone per line item or single phone for all (Stage 2 keeps it simple: one recipient phone for the whole order if bundles present, plus per-line recipient override optional).
- Order confirmation page shows bundle details.

Checkout API (`POST /api/studio/drafts/[id]/checkout`):

- Accepts bundle ids alongside item ids (same `itemId` namespace but looked up in both collections).
- Re-prices server-side from draft's `dataBundles` (never trust client price).
- Requires `bundleRecipientPhone` when bundles in basket, validates Ghana E.164.
- Snapshots bundle meta into `OrderLine.bundleMeta`.
- Existing delivery-fee, minimum-order, payment-mode logic unchanged.

Orders & Studio:

- `src/app/(app)/studio/orders/[id]` shows bundle badge and recipient phone.
- Merchant can mark as Preparing → Out for delivery → Delivered, same as physical goods.
- `POST /api/studio/orders/[id]` already validates transitions; no change.
- Customer order view (`/account/orders/[id]`) shows bundle timeline.

Analytics:

- `filterAnalyticsOrders` excludes test mode same as before; data bundles included in revenue (they are real sales).
- New helper `summariseDataBundleSales` optional — Stage 2 just ensures existing analytics doesn't break with bundle lines.

Security & limits:

- Same bounded JSON, rate limiting, same-origin, redaction.
- Phone validation reuses `formatGhanaPhone` and E.164 regex.
- No external API calls in Stage 2; fulfillment is manual.

### Stage 3 — Fulfillment (next)

- Integrate BundlesGhana / DataPlug provider API: wallet, balance, buy, status.
- `VALMONT_DATA_PROVIDER_URL`, `KEY`, webhook secret in env + Payments settings page.
- Auto-delivery on paid webhook, retry, failure → manual fallback.
- Order gets `fulfillmentRef`, `deliveredAt` from provider.
- Notifications: SMS to recipient on delivery.
- Tests with mocked provider.

### Stage 4 — Advanced (later)

- Bulk CSV import, custom pricing tiers, agent reseller stores with custom domain + pricing.
- Per-bundle stock / daily limit.
- Public API for merchants to list bundles.
- Playwright e2e for bundle checkout.

## Data model

```ts
type DataNetwork = "mtn" | "telecel" | "airteltigo" | "mtn_up2u";
type DataBundle = {
  id: string;
  network: DataNetwork;
  volume: string; // "1GB", "500MB", "2.5GB" — validated by grammar
  validityDays: number; // 1..365
  price: number; // GHS
  name: string; // auto "MTN 2GB - 30 days" but editable
  description?: string;
  active: boolean;
};
```

OrderLine extension:

```ts
bundleMeta?: {
  network: DataNetwork
  volume: string
  validityDays: number
  recipientPhone?: string
}
```

## Validation

- `npm run format:check` ✅
- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm test` ✅ (new suites: data-bundles, checkout with bundles)
- `npm run build` ✅

## Rollout

- Feature flag off by default; existing shops see nothing new.
- Merchant enables in Step 5 "Data bundles".
- No migration needed — new fields default to empty/off, old drafts parse fine.
- Backup v2 already includes bundles; restore keeps them.
