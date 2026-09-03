import type { CatalogItem } from "./site-brief/schema";

export const BUNDLE_NETWORKS = [
  { id: "mtn", label: "MTN", color: "#FFCC00", textColor: "#000000" },
  { id: "telecel", label: "Telecel", color: "#E30613", textColor: "#FFFFFF" },
  {
    id: "airteltigo",
    label: "AirtelTigo",
    color: "#0A1F44",
    textColor: "#FFFFFF",
  },
] as const;

export type BundleNetworkId = (typeof BUNDLE_NETWORKS)[number]["id"];

export function isBundleNetworkId(value: string): value is BundleNetworkId {
  return BUNDLE_NETWORKS.some((n) => n.id === value);
}

export function bundleNetworkLabel(id: string): string {
  return BUNDLE_NETWORKS.find((n) => n.id === id)?.label ?? id;
}

export function bundleNetworkColors(id: string): { bg: string; fg: string } {
  const found = BUNDLE_NETWORKS.find((n) => n.id === id);
  if (!found) return { bg: "#E2E8F0", fg: "#0A1F44" };
  return { bg: found.color, fg: found.textColor };
}

/**
 * Parses data size from a string like "5GB", "500MB", "2.5GB" into MB.
 * Returns null if not parseable. 1 GB = 1024 MB.
 */
export function parseDataSizeToMb(input: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(MB|GB)\b/i.exec(input);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = match[2].toUpperCase();
  if (unit === "GB") return Math.round(num * 1024);
  return Math.round(num);
}

export function formatDataMb(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}GB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace(/\.0$/, "")}GB`;
  return `${mb}MB`;
}

/**
 * Guesses network from category text or name (Stage 1 fallback).
 */
export function guessNetworkFromItem(
  item: CatalogItem,
): BundleNetworkId | null {
  const category = (item.category ?? "").toLowerCase();
  const name = item.name.toLowerCase();

  if (category.includes("mtn") || name.includes("mtn")) return "mtn";
  if (
    category.includes("telecel") ||
    name.includes("telecel") ||
    category.includes("vodafone") ||
    name.includes("vodafone")
  )
    return "telecel";
  if (
    category.includes("airtel") ||
    category.includes("tigo") ||
    name.includes("airtel") ||
    name.includes("tigo") ||
    category.includes("airteltigo") ||
    name.includes("airteltigo")
  )
    return "airteltigo";

  return null;
}

/**
 * Guesses data MB from name (Stage 1 fallback).
 */
export function guessDataMbFromItem(item: CatalogItem): number | null {
  if (
    item.bundle?.dataMb &&
    Number.isFinite(item.bundle.dataMb) &&
    item.bundle.dataMb > 0
  ) {
    return item.bundle.dataMb;
  }
  return parseDataSizeToMb(item.name);
}

/**
 * Gets network, preferring structured field, fallback to guessing.
 */
export function getBundleNetwork(item: CatalogItem): BundleNetworkId | null {
  if (item.bundle?.network && isBundleNetworkId(item.bundle.network)) {
    return item.bundle.network;
  }
  return guessNetworkFromItem(item);
}

/**
 * Groups bundles by network, using structured field first, text-guessing fallback.
 * Only priced items are considered bundles for the shop.
 */
export function groupBundlesByNetwork(
  items: CatalogItem[],
): Record<BundleNetworkId, CatalogItem[]> {
  const grouped: Record<BundleNetworkId, CatalogItem[]> = {
    mtn: [],
    telecel: [],
    airteltigo: [],
  };

  for (const item of items) {
    if (item.price === undefined) continue;
    const network = getBundleNetwork(item);
    if (!network) continue;
    grouped[network].push(item);
  }

  for (const key of Object.keys(grouped) as BundleNetworkId[]) {
    grouped[key].sort((a, b) => {
      const aMb = guessDataMbFromItem(a) ?? 0;
      const bMb = guessDataMbFromItem(b) ?? 0;
      if (aMb !== bMb) return aMb - bMb;
      return (a.price ?? 0) - (b.price ?? 0);
    });
  }

  return grouped;
}

/**
 * Starter catalogue — 18 bundles with placeholder prices, each with structured bundle field.
 * Stable ids so reloading never duplicates when merged by id.
 */
export function starterBundleCatalogue(): CatalogItem[] {
  const makeId = (index: number) =>
    `bundle-${index.toString().padStart(2, "0")}`;

  const bundles: Array<{
    network: BundleNetworkId;
    mb: number;
    validity: string;
    price: number;
  }> = [
    { network: "mtn", mb: 1024, validity: "7 days", price: 10 },
    { network: "mtn", mb: 2048, validity: "30 days", price: 15 },
    { network: "mtn", mb: 3072, validity: "30 days", price: 20 },
    { network: "mtn", mb: 5120, validity: "30 days", price: 30 },
    { network: "mtn", mb: 10240, validity: "30 days", price: 50 },
    { network: "mtn", mb: 20480, validity: "30 days", price: 90 },
    { network: "telecel", mb: 1024, validity: "7 days", price: 9 },
    { network: "telecel", mb: 2048, validity: "30 days", price: 14 },
    { network: "telecel", mb: 3072, validity: "30 days", price: 19 },
    { network: "telecel", mb: 5120, validity: "30 days", price: 28 },
    { network: "telecel", mb: 10240, validity: "30 days", price: 48 },
    { network: "telecel", mb: 20480, validity: "30 days", price: 85 },
    { network: "airteltigo", mb: 1024, validity: "7 days", price: 9 },
    { network: "airteltigo", mb: 2048, validity: "30 days", price: 14 },
    { network: "airteltigo", mb: 3072, validity: "30 days", price: 19 },
    { network: "airteltigo", mb: 5120, validity: "30 days", price: 27 },
    { network: "airteltigo", mb: 10240, validity: "30 days", price: 45 },
    { network: "airteltigo", mb: 20480, validity: "30 days", price: 80 },
  ];

  return bundles.map((b, index) => {
    const sizeLabel = formatDataMb(b.mb);
    const networkLabel = bundleNetworkLabel(b.network);
    return {
      id: makeId(index),
      name: `${networkLabel} ${sizeLabel}`,
      price: b.price,
      category: b.network,
      description: `${sizeLabel} - ${b.validity}`,
      bundle: {
        network: b.network,
        dataMb: b.mb,
        validity: b.validity,
      },
    } as CatalogItem;
  });
}

export function mergeStarterBundles(
  existing: CatalogItem[],
  starter: CatalogItem[] = starterBundleCatalogue(),
): CatalogItem[] {
  const existingIds = new Set(existing.map((i) => i.id));
  const newOnes = starter.filter((s) => !existingIds.has(s.id));
  return [...existing, ...newOnes];
}

/**
 * Ghana mobile validation — only 02x and 05x, saved as 0240000001 (10 digits, leading 0).
 * Accepts E.164 +233, local 0xxxxxxxxx, or spaced/dashed variants.
 * Single source of truth for landline/invalid explainer (used by storefront and checkout route).
 */
export function validateGhanaMobile(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "Phone number is required";
  const cleaned = trimmed.replace(/[\s\-()]/g, "");

  // Landline detection — 030 / 03x is not mobile, show specific message
  if (/^(?:\+?233|0)3\d{7,8}$/.test(cleaned)) {
    return "Landline numbers (030) are not supported. Please use a mobile number starting with 02x or 05x.";
  }

  // Valid Ghana mobile: 0 + 2x/5x + 7 digits, or 233 + 2x/5x + 7, or +233 + 2x/5x + 7
  if (cleaned.startsWith("+233")) {
    const local = cleaned.slice(4);
    if (/^(?:2[0-9]|5[0-9])\d{7}$/.test(local)) return null;
  } else if (cleaned.startsWith("233")) {
    const local = cleaned.slice(3);
    if (/^(?:2[0-9]|5[0-9])\d{7}$/.test(local)) return null;
  } else if (cleaned.startsWith("0")) {
    if (/^0(?:2[0-9]|5[0-9])\d{7}$/.test(cleaned)) return null;
  }

  return "Please enter a Ghana mobile number starting with 02x or 05x, e.g. 0240000001";
}

export function isValidGhanaMobile(input: string): boolean {
  return validateGhanaMobile(input) === null;
}

export function normalizeGhanaMobile(input: string): string | null {
  if (!isValidGhanaMobile(input)) return null;
  const cleaned = input.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("+233")) {
    const rest = cleaned.slice(4);
    return `0${rest}`;
  }
  if (cleaned.startsWith("233")) {
    const rest = cleaned.slice(3);
    return `0${rest}`;
  }
  return cleaned;
}

/**
 * Masks a phone number for display on pages a stranger can open.
 *
 * The guest order-confirmation page (`/orders/<id>/confirmed`) needs no login,
 * so a full number printed there is public the moment the order exists.
 * "0240000001" becomes "024 ••• 0001": the prefix is enough for a customer to
 * recognise which number they entered, while the middle digits stay hidden.
 *
 * Short or empty input is masked entirely rather than echoed back, so an
 * unexpected value can never leak a number that does not fit the expected
 * shape. Only ever used for display — storage and delivery keep the full
 * number.
 */
export function maskGhanaMobile(input: string | null | undefined): string {
  const cleaned = (input ?? "").trim().replace(/[\s\-()]/g, "");
  if (cleaned.length < 8) return "••• ••• ••••";
  return `${cleaned.slice(0, 3)} ••• ${cleaned.slice(-4)}`;
}

export function checkRecipientNetworkMatch(
  recipientPhone: string,
  bundleNetwork: BundleNetworkId,
): { matches: boolean; warning?: string } {
  const normalized = normalizeGhanaMobile(recipientPhone);
  if (!normalized) return { matches: true };

  const prefix = normalized.slice(0, 3);
  const mtnPrefixes = ["024", "025", "053", "054", "055", "059"];
  const telecelPrefixes = ["020", "050"];
  const airteltigoPrefixes = ["026", "027", "056", "057"];

  let guessedNetwork: BundleNetworkId | null = null;
  if (mtnPrefixes.includes(prefix)) guessedNetwork = "mtn";
  else if (telecelPrefixes.includes(prefix)) guessedNetwork = "telecel";
  else if (airteltigoPrefixes.includes(prefix)) guessedNetwork = "airteltigo";

  if (guessedNetwork && guessedNetwork !== bundleNetwork) {
    return {
      matches: false,
      warning: `This number looks like ${bundleNetworkLabel(guessedNetwork)}, but you're buying ${bundleNetworkLabel(bundleNetwork)}. Please confirm.`,
    };
  }

  return { matches: true };
}
