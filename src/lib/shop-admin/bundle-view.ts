import type { CatalogItem } from "@/lib/studio/site-brief/schema";

/**
 * Stage 6c — the shop's view of its own bundle catalogue.
 *
 * The shop admin side must never receive the raw brief: it carries payment
 * settings, the Valmont Pay key, `adminEmail` and agency bookkeeping. The
 * bundles page and the bundles API route both narrow the catalogue through
 * this projection instead — one item in, one flat row out, nothing else.
 */
export interface ShopCatalogueItemView {
  id: string;
  name: string;
  network: string | null;
  dataMb: number | null;
  validity: string | null;
  price: number | null;
  paused: boolean;
}

/**
 * Projects a catalogue into what the shop may see. `paused` is normalised to
 * a boolean (an omitted key means "not paused" as far as the shop is
 * concerned); network, size and validity come from the bundle metadata and
 * stay null for an item that somehow has none.
 */
export function shopCatalogueView(
  items: readonly CatalogItem[],
): ShopCatalogueItemView[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    network: item.bundle?.network ?? null,
    dataMb: item.bundle?.dataMb ?? null,
    validity: item.bundle?.validity ?? null,
    price: item.price ?? null,
    paused: item.paused === true,
  }));
}
