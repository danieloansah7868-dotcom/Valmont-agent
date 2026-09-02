import type { SiteBriefV1 } from "./schema";
import { isStarterValue } from "./defaults";

export const READINESS_RULES_VERSION = 2;

/** A single thing the Brief still needs, with plain-language wording. */
export interface BriefGap {
  field: string;
  label: string;
  /** `required` blocks a finished website; `recommended` only weakens it. */
  severity: "required" | "recommended";
  /** What the owner should do about it, in everyday words. */
  hint: string;
}

export interface BriefCompleteness {
  /** 0–100. Required fields are worth twice a recommended one. */
  score: number;
  gaps: BriefGap[];
  missingRequired: BriefGap[];
  recommended: BriefGap[];
  /** True when every required field is filled in. */
  readyForHandoff: boolean;
  earnedPoints: number;
  totalPoints: number;
}

const REQUIRED_WEIGHT = 2;
const RECOMMENDED_WEIGHT = 1;

/** Marker shown in the preview wherever information is still missing. */
export const PLACEHOLDER_TEXT = "Not provided yet";

interface Rule {
  field: string;
  label: string;
  severity: BriefGap["severity"];
  hint: string;
  satisfied(brief: Partial<SiteBriefV1>): boolean;
  applicable?: (brief: Partial<SiteBriefV1>) => boolean;
}

function filled(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

const RULES: Rule[] = [
  {
    field: "businessName",
    label: "Business name",
    severity: "required",
    hint: "Type the name customers should see at the top of the website.",
    satisfied: (brief) =>
      filled(brief.businessName) &&
      brief.businessName!.trim().length >= 2 &&
      !isStarterValue("businessName", brief.businessName),
  },
  {
    field: "category",
    label: "Website type",
    severity: "required",
    hint: "Pick the type of website in step 1.",
    satisfied: (brief) => filled(brief.category),
  },
  {
    field: "selectedPackage",
    label: "Package",
    severity: "required",
    hint: "Choose a package in step 2.",
    satisfied: (brief) => filled(brief.selectedPackage),
  },
  {
    field: "selectedTheme",
    label: "Look and feel",
    severity: "required",
    hint: "Choose a theme in step 3.",
    satisfied: (brief) => filled(brief.selectedTheme),
  },
  {
    field: "adminEmail",
    label: "Admin email",
    severity: "required",
    hint: "The email address Valmont should use to reach you about this website.",
    satisfied: (brief) =>
      filled(brief.adminEmail) &&
      !isStarterValue("adminEmail", brief.adminEmail),
  },
  {
    field: "contact",
    label: "Phone or WhatsApp number",
    severity: "required",
    hint: "Customers need at least one way to reach you. Add a phone or WhatsApp number.",
    satisfied: (brief) => filled(brief.phone) || filled(brief.whatsapp),
  },
  {
    field: "description",
    label: "Business description",
    severity: "recommended",
    hint: "A short paragraph about what your business does.",
    satisfied: (brief) => filled(brief.description),
  },
  {
    field: "tagline",
    label: "Tagline",
    severity: "recommended",
    hint: "One short line that sums up your business.",
    satisfied: (brief) => filled(brief.tagline),
  },
  {
    field: "address",
    label: "Address or location",
    severity: "recommended",
    hint: "Where you are based, so customers can find you.",
    satisfied: (brief) => filled(brief.address),
  },
  {
    field: "hours",
    label: "Opening hours",
    severity: "recommended",
    hint: "The days and times you are open.",
    satisfied: (brief) => filled(brief.hours),
  },
  {
    field: "offerings",
    label: "Services or products",
    severity: "recommended",
    hint: "List a few services you provide, or the kinds of products you sell.",
    satisfied: (brief) =>
      filled(brief.services) || filled(brief.products) || filled(brief.items),
  },
  {
    field: "coverage",
    label: "Service or delivery areas",
    severity: "recommended",
    hint: "The towns or regions you cover.",
    satisfied: (brief) =>
      filled(brief.serviceAreas) || filled(brief.deliveryAreas),
  },
  {
    field: "bundleCatalogue",
    label: "Data bundles catalogue",
    severity: "required",
    hint: "Add at least one priced bundle. Use the bundle table in step 4.",
    applicable: (brief) => brief.category === "data-bundles",
    satisfied: (brief) => {
      const items = brief.items ?? [];
      if (items.length === 0) return false;
      const priced = items.filter((i) => i.price !== undefined);
      if (priced.length === 0) return false;
      return priced.some((i) => i.bundle?.network && i.bundle?.dataMb);
    },
  },
  {
    field: "bundleMetadata",
    label: "Bundle details",
    severity: "required",
    hint: "Every priced bundle must have a network and size. Fill in the table.",
    applicable: (brief) => brief.category === "data-bundles",
    satisfied: (brief) => {
      const items = brief.items ?? [];
      const priced = items.filter((i) => i.price !== undefined);
      // Vacuously true when no priced items — only bundleCatalogue should fire for empty shop
      return priced.every((i) => i.bundle?.network && i.bundle?.dataMb);
    },
  },
];

/**
 * Scores how complete a Site Brief is. The score is a straight weighted count
 * of satisfied rules, so it moves predictably as fields are filled in.
 * Rules with an `applicable` predicate only count when applicable.
 */
export function computeBriefCompleteness(
  brief: Partial<SiteBriefV1>,
): BriefCompleteness {
  const gaps: BriefGap[] = [];
  let earnedPoints = 0;
  let totalPoints = 0;

  for (const rule of RULES) {
    if (rule.applicable && !rule.applicable(brief)) {
      continue;
    }
    const weight =
      rule.severity === "required" ? REQUIRED_WEIGHT : RECOMMENDED_WEIGHT;
    totalPoints += weight;
    if (rule.satisfied(brief)) {
      earnedPoints += weight;
    } else {
      gaps.push({
        field: rule.field,
        label: rule.label,
        severity: rule.severity,
        hint: rule.hint,
      });
    }
  }

  const missingRequired = gaps.filter((gap) => gap.severity === "required");
  return {
    score:
      totalPoints === 0 ? 100 : Math.round((earnedPoints / totalPoints) * 100),
    gaps,
    missingRequired,
    recommended: gaps.filter((gap) => gap.severity === "recommended"),
    readyForHandoff: missingRequired.length === 0,
    earnedPoints,
    totalPoints,
  };
}

/**
 * Returns the value to show in the preview, or the placeholder marker when the
 * owner has not filled it in. Callers style the placeholder differently rather
 * than parsing the text back out again.
 */
export function displayValue(value: unknown): {
  text: string;
  isPlaceholder: boolean;
} {
  if (typeof value === "string" && value.trim())
    return { text: value.trim(), isPlaceholder: false };
  return { text: PLACEHOLDER_TEXT, isPlaceholder: true };
}
