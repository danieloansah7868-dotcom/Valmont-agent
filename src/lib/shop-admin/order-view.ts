import { bundleNetworkLabel, formatDataMb } from "@/lib/studio/bundles";
import type { BundleNetworkId } from "@/lib/studio/bundles";
import type { OrderLine } from "@/lib/studio/orders";
import type {
  BundleDeliveryRecord,
  DeliveryStatus,
} from "@/lib/studio/bundle-delivery";

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
