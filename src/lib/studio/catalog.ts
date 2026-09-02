import type { CatalogItem } from "./site-brief/schema";

/**
 * Parses priced-item text into catalogue items.
 *
 * Owners type naturally — one item per line, or a comma-separated list, or
 * both. An entry with no "- price" part becomes an unpriced (info-only) item.
 * Existing items are matched by name so their ids (and any images) survive
 * a re-parse.
 */
export function parsePricedItems(
  text: string,
  existing: CatalogItem[] = [],
): CatalogItem[] {
  const byName = new Map(
    existing.map((item) => [item.name.trim().toLowerCase(), item]),
  );
  return text
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const match = /^(.*?)(?:\s*-\s*([0-9]+(?:\.[0-9]{1,2})?))?$/.exec(entry);
      const rawName = (match?.[1] ?? entry).trim();
      const priceText = match?.[2];
      const prior = byName.get(rawName.toLowerCase());
      const item: CatalogItem = {
        id: prior?.id ?? `item-${Date.now()}-${index}`,
        name: rawName,
      };
      if (priceText !== undefined) item.price = Number(priceText);
      else if (prior?.price !== undefined) item.price = prior.price;
      if (prior?.category) item.category = prior.category;
      if (prior?.description) item.description = prior.description;
      if (prior?.image) item.image = prior.image;
      if (prior?.bundle) item.bundle = prior.bundle;
      return item;
    });
}

/** Renders catalogue items back to editable "Name - price" text, one per line. */
export function formatPricedItems(items: CatalogItem[]): string {
  return items
    .map((item) =>
      item.price !== undefined ? `${item.name} - ${item.price}` : item.name,
    )
    .join("\n");
}

export function publicSitePath(draftId: string): string {
  return `/s/${draftId}`;
}
