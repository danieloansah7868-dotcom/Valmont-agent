import { z } from "zod";
import { redactPaymentData, redactSecrets } from "@/lib/redact";

export const DATA_NETWORKS = [
  { id: "mtn", label: "MTN", color: "#FFCC00", textColor: "#000000" },
  { id: "telecel", label: "Telecel", color: "#E30613", textColor: "#FFFFFF" },
  {
    id: "airteltigo",
    label: "AirtelTigo",
    color: "#0A1F44",
    textColor: "#FFFFFF",
  },
  { id: "mtn_up2u", label: "MTN Up2U", color: "#E8822B", textColor: "#000000" },
] as const;

export type DataNetworkId = (typeof DATA_NETWORKS)[number]["id"];

export function isDataNetworkId(value: string): value is DataNetworkId {
  return DATA_NETWORKS.some((n) => n.id === value);
}

export function dataNetworkLabel(id: string): string {
  return DATA_NETWORKS.find((n) => n.id === id)?.label ?? id;
}

export function dataNetworkColors(id: string): {
  bg: string;
  fg: string;
} {
  const found = DATA_NETWORKS.find((n) => n.id === id);
  if (!found) return { bg: "#E2E8F0", fg: "#0A1F44" };
  return { bg: found.color, fg: found.textColor };
}

/**
 * Volume grammar: e.g. 500MB, 1GB, 2.5GB, 10GB. Accepts optional space.
 * Stored normalized as uppercase without space: "2.5GB".
 */
const VOLUME_RE = /^\s*(\d+(?:\.\d+)?)\s*(MB|GB)\s*$/i;

export function normalizeVolume(input: string): string | null {
  const match = VOLUME_RE.exec(input);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0 || num > 1_000_000) return null;
  // Keep up to 2 decimal places, trim trailing zeros
  const normalizedNum = num.toFixed(2).replace(/\.00$/, "").replace(/\.0$/, "");
  const unit = match[2].toUpperCase();
  return `${normalizedNum}${unit}`;
}

export function isValidVolume(value: string): boolean {
  return normalizeVolume(value) !== null;
}

const freeText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => redactPaymentData(redactSecrets(value)));

export const dataBundleSchema = z.object({
  id: z.string().max(64),
  network: z.string().refine(isDataNetworkId, "Invalid network"),
  volume: z
    .string()
    .max(20)
    .refine(isValidVolume, "Volume must be like 1GB or 500MB"),
  validityDays: z.number().int().min(1).max(365),
  price: z
    .union([z.number(), z.string()])
    .transform((value) => {
      if (typeof value === "number") return value;
      const cleaned = value.replace(/[^0-9.]/g, "");
      return cleaned === "" ? 0 : Number(cleaned);
    })
    .pipe(
      z
        .number()
        .min(0, "Price cannot be negative")
        .max(1_000_000, "Price is too large")
        .refine(
          (n) => Number.isFinite(n) && Math.round(n * 100) === n * 100,
          "Price can have at most two decimal places",
        ),
    ),
  name: freeText(80),
  description: freeText(300).optional(),
  active: z.boolean().default(true),
});

export type DataBundle = z.infer<typeof dataBundleSchema>;

/**
 * Auto-generate a human name: "MTN 2GB - 30 days"
 */
export function autoBundleName(input: {
  network: DataNetworkId;
  volume: string;
  validityDays: number;
}): string {
  const normalized = normalizeVolume(input.volume) ?? input.volume.trim();
  const networkLabel = dataNetworkLabel(input.network);
  const days = input.validityDays;
  const validityLabel = days === 1 ? "1 day" : `${days} days`;
  return `${networkLabel} ${normalized} - ${validityLabel}`;
}

/**
 * Parse a line like "MTN 2GB 30days - 15" or "Telecel 5GB - 35"
 * Very forgiving for merchant UX — used by wizard bulk text area.
 *
 * Supported forms:
 *  - "2GB - 15" (network defaults to mtn, validity 30)
 *  - "MTN 2GB - 15"
 *  - "MTN 2GB 30days - 15"
 *  - "Telecel 5GB 7 days - 20"
 */
export function parseDataBundleText(
  text: string,
  existing: DataBundle[] = [],
): DataBundle[] {
  const byName = new Map(existing.map((b) => [b.name.trim().toLowerCase(), b]));
  const lines = text
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return lines.map((entry, index) => {
    // Try to extract price: last dash + number
    const priceMatch = /^(.*?)(?:\s*-\s*([0-9]+(?:\.[0-9]{1,2})?))?\s*$/.exec(
      entry,
    );
    const left = (priceMatch?.[1] ?? entry).trim();
    const priceText = priceMatch?.[2];

    // Detect network at start
    let network: DataNetworkId = "mtn";
    let rest = left;
    const lower = left.toLowerCase();
    for (const net of DATA_NETWORKS) {
      const labels = [
        net.id,
        net.label.toLowerCase(),
        net.id.replace("_", " "),
        net.id.replace("_", ""),
      ];
      for (const lbl of labels) {
        if (lower.startsWith(lbl)) {
          network = net.id;
          rest = left.slice(lbl.length).trim();
          break;
        }
      }
      if (rest !== left) break;
    }
    // Handle "mtn up2u" as two words
    if (lower.startsWith("mtn up2u") || lower.startsWith("up2u")) {
      network = "mtn_up2u";
      rest = left
        .replace(/^mtn\s*up2u/i, "")
        .replace(/^up2u/i, "")
        .trim();
    }

    // Detect validity: e.g. "30days", "30 days", "7day"
    let validityDays = 30;
    const validityMatch = /(\d+)\s*(?:day|days|d)\b/i.exec(rest);
    if (validityMatch) {
      const v = Number(validityMatch[1]);
      if (Number.isFinite(v) && v >= 1 && v <= 365) validityDays = v;
      rest = rest.replace(validityMatch[0], "").trim();
    }

    // Remaining should be volume
    let volume = rest.trim();
    if (!volume) volume = "1GB";
    const normalizedVolume = normalizeVolume(volume) ?? volume;

    const prior = byName.get(left.toLowerCase());
    const id = prior?.id ?? `bundle-${Date.now()}-${index}`;

    const price =
      priceText !== undefined
        ? Number(priceText)
        : prior?.price !== undefined
          ? prior.price
          : 0;

    const name =
      prior?.name ??
      autoBundleName({ network, volume: normalizedVolume, validityDays });

    const bundle: DataBundle = {
      id,
      network,
      volume: normalizedVolume,
      validityDays,
      price,
      name,
      active: prior?.active ?? true,
    };
    if (prior?.description) bundle.description = prior.description;
    return bundle;
  });
}

export function formatDataBundles(bundles: DataBundle[]): string {
  return bundles
    .map((b) => {
      const vol = normalizeVolume(b.volume) ?? b.volume;
      const netLabel = dataNetworkLabel(b.network);
      return `${netLabel} ${vol} ${b.validityDays}days - ${b.price}`;
    })
    .join("\n");
}

export function bundleDisplayName(bundle: DataBundle): string {
  return bundle.name || autoBundleName(bundle);
}

export function isBundleActive(bundle: DataBundle): boolean {
  return bundle.active !== false;
}

/**
 * Group bundles by network for storefront display.
 */
export function groupBundlesByNetwork(
  bundles: DataBundle[],
): Record<DataNetworkId, DataBundle[]> {
  const grouped = {} as Record<DataNetworkId, DataBundle[]>;
  for (const net of DATA_NETWORKS) {
    grouped[net.id] = [];
  }
  for (const bundle of bundles) {
    if (!isDataNetworkId(bundle.network)) continue;
    if (!isBundleActive(bundle)) continue;
    if (!grouped[bundle.network]) grouped[bundle.network] = [];
    grouped[bundle.network].push(bundle);
  }
  // Sort each group by price ascending
  for (const key of Object.keys(grouped) as DataNetworkId[]) {
    grouped[key].sort((a, b) => a.price - b.price);
  }
  return grouped;
}

/**
 * Validate recipient phone for bundles — Ghana numbers.
 * Accepts E.164 or local 0xxx.
 */
const GH_PHONE_RE = /^(?:\+233\d{9}|0\d{9})$/;

export function isValidBundleRecipientPhone(phone: string): boolean {
  const trimmed = phone.trim();
  // Reuse the Ghana formatting logic: +233xxxxxxxxx or 0xxxxxxxxx
  if (GH_PHONE_RE.test(trimmed)) return true;
  // Also allow +233 with spaces/dashes stripped earlier
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return true;
  if (digits.startsWith("0") && digits.length === 10) return true;
  return false;
}
