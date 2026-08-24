import type { SiteBriefV1 } from "./schema";

/**
 * Ghana-friendly starting values. Every one of these is editable in the wizard —
 * they are defaults, not fixed settings.
 */
export const GHANA_DEFAULTS = {
  country: "Ghana",
  currency: "GHS",
  currencySymbol: "GH₵",
  timezone: "Africa/Accra",
  phoneCountryCode: "+233",
  preferredLanguage: "en",
} as const;

/** The ten regions most Ghanaian businesses pick from, plus the rest. */
export const GHANA_REGIONS = [
  "Greater Accra",
  "Ashanti",
  "Western",
  "Western North",
  "Central",
  "Eastern",
  "Volta",
  "Oti",
  "Northern",
  "Savannah",
  "North East",
  "Upper East",
  "Upper West",
  "Bono",
  "Bono East",
  "Ahafo",
] as const;

export type GhanaRegion = (typeof GHANA_REGIONS)[number];

export function isGhanaRegion(value: string): value is GhanaRegion {
  return (GHANA_REGIONS as readonly string[]).includes(value);
}

/**
 * The country choices offered in the wizard. Ghana is the default; the rest
 * are supported alternatives a draft may choose between. The Site Brief is
 * planning data in Phase 1 — no code generation or pricing runs on these
 * values yet — so the list is deliberately small and honest.
 */
export const SUPPORTED_COUNTRIES = [
  "Ghana",
  "Nigeria",
  "Kenya",
  "United Kingdom",
  "United States",
] as const;

export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];

export function isSupportedCountry(value: string): value is SupportedCountry {
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(value);
}

export const SUPPORTED_CURRENCIES = [
  { code: "GHS", label: "GHS — Ghana cedi (GH₵)" },
  { code: "NGN", label: "NGN — Nigerian naira (₦)" },
  { code: "KES", label: "KES — Kenyan shilling (KSh)" },
  { code: "GBP", label: "GBP — pound sterling (£)" },
  { code: "USD", label: "USD — US dollar ($)" },
] as const;

export type SupportedCurrencyCode =
  (typeof SUPPORTED_CURRENCIES)[number]["code"];

export function isSupportedCurrency(value: string): boolean {
  return (SUPPORTED_CURRENCIES as readonly { code: string }[]).some(
    (item) => item.code === value,
  );
}

export const SUPPORTED_TIMEZONES = [
  "Africa/Accra",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Europe/London",
  "America/New_York",
] as const;

export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

export function isSupportedTimezone(value: string): value is SupportedTimezone {
  return (SUPPORTED_TIMEZONES as readonly string[]).includes(value);
}

/**
 * Payment methods a business says it would *like* later. Phase 1 records the
 * preference only — nothing is connected, and no money can move.
 */
export const PLANNED_PAYMENT_METHODS = [
  { id: "momo", label: "Mobile Money (MTN, Telecel, AirtelTigo)" },
  { id: "paystack", label: "Paystack" },
  { id: "valmont_pay", label: "Valmont Pay" },
  { id: "card", label: "Debit / credit card" },
  { id: "bank", label: "Bank transfer" },
  { id: "cod", label: "Cash on delivery" },
] as const;

export const PAYMENT_PLANNING_NOTICE =
  "Planning information only. No payment method is connected and no payment, checkout or delivery feature works in Phase 1.";

/**
 * Formats a Ghanaian phone number typed in any common local style into the
 * E.164 form the schema requires (`+233XXXXXXXXX`). Returns the trimmed input
 * unchanged when it does not look like a Ghana number, so the schema — not this
 * helper — decides what is valid.
 */
export function formatGhanaPhone(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const digits = trimmed.replace(/[^\d+]/g, "");

  if (digits.startsWith("+233")) {
    const rest = digits.slice(4).replace(/\D/g, "");
    return rest ? `+233${rest.replace(/^0+/, "")}` : "+233";
  }
  if (digits.startsWith("00233")) return `+233${digits.slice(5)}`;
  if (digits.startsWith("233")) return `+233${digits.slice(3)}`;
  // Local nine-digit form written with a leading zero, e.g. 024 245 1578.
  if (/^0\d{9}$/.test(digits)) return `+233${digits.slice(1)}`;
  return trimmed;
}

/** Money shown to the user, e.g. GH₵3,500. Display only — no pricing logic. */
export function formatGhanaCurrency(amount: number): string {
  return `${GHANA_DEFAULTS.currencySymbol}${amount.toLocaleString("en-GH")}`;
}

/**
 * Fills in the Ghana defaults for any field the caller has not set. Values the
 * user already chose always win.
 */
export function applyGhanaDefaults(
  brief: Partial<SiteBriefV1>,
): Partial<SiteBriefV1> {
  return {
    country: GHANA_DEFAULTS.country,
    currency: GHANA_DEFAULTS.currency,
    timezone: GHANA_DEFAULTS.timezone,
    preferredLanguage: GHANA_DEFAULTS.preferredLanguage,
    ...Object.fromEntries(
      Object.entries(brief).filter(([, value]) => value !== undefined),
    ),
  };
}

/**
 * A brand-new brief. Every required field carries a real, schema-valid value so
 * a fresh draft saves immediately; the wizard then asks the owner to replace the
 * starter business name and admin email with their own.
 */
export function createDefaultBrief(
  overrides: Partial<SiteBriefV1> = {},
): SiteBriefV1 {
  return {
    schemaVersion: 1,
    businessName: "My business",
    category: "business-profile",
    socialLinks: [],
    serviceAreas: [],
    deliveryAreas: [],
    services: [],
    products: [],
    requiredPages: [],
    selectedPackage: "starter",
    selectedTheme: "clean-corporate",
    selectedTemplate: "classic-hero",
    adminEmail: "owner@example.com",
    assets: { logo: null, photos: [] },
    items: [],
    payments: {
      enabled: false,
      methods: [],
      valmontPay: { provisioned: false },
      delivery: { enabled: false, fee: 0, minimumOrder: 0 },
      notifications: {},
      staged: { enabled: false, stages: [] },
    },
    plannedPaymentMethods: [],
    country: GHANA_DEFAULTS.country,
    currency: GHANA_DEFAULTS.currency,
    timezone: GHANA_DEFAULTS.timezone,
    preferredLanguage: GHANA_DEFAULTS.preferredLanguage,
    ...overrides,
  };
}

/**
 * Values the wizard treats as "starter text the owner has not replaced yet".
 * They are valid to save but must not count towards Brief completeness.
 */
export const STARTER_VALUES = {
  businessName: "My business",
  adminEmail: "owner@example.com",
} as const;

export function isStarterValue(
  field: keyof typeof STARTER_VALUES,
  value: unknown,
): boolean {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase() === STARTER_VALUES[field].toLowerCase()
  );
}
