import { bundleNetworkLabel, formatDataMb } from "@/lib/studio/bundles";
import type { OrderLine } from "@/lib/studio/orders";

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
