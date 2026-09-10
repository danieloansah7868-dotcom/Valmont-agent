import { bundleNetworkLabel, formatDataMb } from "@/lib/studio/bundles";
import type { BundleNetworkId } from "@/lib/studio/bundles";
import type { OrderLine } from "@/lib/studio/orders";
import type {
  BundleDeliveryRecord,
  DeliveryStatus,
} from "@/lib/studio/bundle-delivery";
import { AGENT_WALLET_PAYMENT_METHOD } from "@/lib/shop-agent/orders";
import { PAYMENT_METHODS } from "@/lib/studio/site-brief/schema";

/**
 * "MTN 5GB × 2" for a bundle line, "<name> × <qty>" for anything else. The
 * network and size are optional on the snapshot, so each falls back to the
 * catalogue name rather than printing "undefined".
 */
export function shopOrderLineLabel(line: OrderLine): string {
  const network = line.bundle?.network
    ? bundleNetworkLabel(line.bundle.network)
    : null;
  const size =
    typeof line.bundle?.dataMb === "number" && line.bundle.dataMb > 0
      ? formatDataMb(line.bundle.dataMb)
      : null;
  const head = network && size ? `${network} ${size}` : line.name;
  return `${head} × ${line.quantity}`;
}

/**
 * Stage 7b — a payment method as a person reads it. `agent_wallet` is NOT in
 * PAYMENT_METHODS on purpose (R7: never selectable in Studio or on the public
 * storefront), so a raw lookup would print the machine string "agent_wallet"
 * back at the owner — this label keeps those orders readable while every
 * known method keeps its PAYMENT_METHODS label, and anything unknown still
 * falls back to the raw string rather than inventing a name.
 */
export function paymentMethodLabel(method: string): string {
  if (method === AGENT_WALLET_PAYMENT_METHOD) return "Agent wallet";
  return PAYMENT_METHODS.find((entry) => entry.id === method)?.label ?? method;
}

/**
 * Stage 6c — one delivery row as the shop's browser may see it.
 *
 * A raw `BundleDeliveryRecord` carries `ownerId` (an agency identifier) plus
 * catalogue bookkeeping the shop side never renders, so every delivery that
 * leaves a shop-admin API route — mark, retry, recheck — is narrowed through
 * this projection first. Exactly the fields the 6b order page already shows.
 */
export interface ShopDeliveryView {
  id: string;
  lineIndex: number;
  unitIndex: number;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
  recipientPhone: string;
  provider: string;
  status: DeliveryStatus;
  attempts: number;
  providerRef?: string;
  lastError?: string;
  deliveredAt?: string;
  updatedAt: string;
}

/** Narrows a delivery row to {@link ShopDeliveryView}. No `ownerId` survives. */
export function shopDeliveryView(row: BundleDeliveryRecord): ShopDeliveryView {
  return {
    id: row.id,
    lineIndex: row.lineIndex,
    unitIndex: row.unitIndex,
    network: row.network,
    dataMb: row.dataMb,
    validity: row.validity,
    recipientPhone: row.recipientPhone,
    provider: row.provider,
    status: row.status,
    attempts: row.attempts,
    providerRef: row.providerRef,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt,
    updatedAt: row.updatedAt,
  };
}
