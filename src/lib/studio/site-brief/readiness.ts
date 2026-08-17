import type { SiteBriefV1 } from "./schema";

export const READINESS_RULES_VERSION = 1;

export interface BriefCompleteness {
  score: number; // 0-100
  missingRequired: string[];
  warnings: string[];
  placeholders: string[];
}

export function computeBriefCompleteness(
  brief: Partial<SiteBriefV1>,
): BriefCompleteness {
  const missing: string[] = [];
  if (!brief.businessName || brief.businessName.trim().length < 2)
    missing.push("businessName");
  if (!brief.category) missing.push("category");
  if (!brief.selectedPackage) missing.push("selectedPackage");
  if (!brief.selectedTheme) missing.push("selectedTheme");
  if (!brief.adminEmail) missing.push("adminEmail");
  const warnings: string[] = [];
  if (!brief.description) warnings.push("description");
  if (!brief.phone && !brief.whatsapp) warnings.push("phone or whatsapp");
  if (!brief.address) warnings.push("address");
  const placeholders: string[] = [...missing, ...warnings].map(
    (f) => `— not yet provided: ${f} —`,
  );
  const total = 5 + 3; // 5 required + 3 warnings weight
  const done = 5 - missing.length + Math.max(0, 3 - warnings.length);
  const score = Math.round((done / total) * 100);
  return { score, missingRequired: missing, warnings, placeholders };
}

export function hasPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.includes("— not yet provided");
}
