import { CATEGORY_IDS, type CategoryId } from "./categories";

export const TEMPLATE_IDS = [
  "classic-hero",
  "split-features",
  "magazine",
  "minimal-cards",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface TemplateManifest {
  id: TemplateId;
  label: string;
  description: string;
  /** Sections this layout renders, in order. Phase 1 preview uses these. */
  sections: string[];
  /**
   * Website types this layout suits. `"*"` means every type, which keeps the
   * "Custom Website" category from ever having zero choices.
   */
  compatibleCategories: readonly CategoryId[] | "*";
}

export const TEMPLATE_REGISTRY_VERSION = 1;

export const templates: TemplateManifest[] = [
  {
    id: "classic-hero",
    label: "Classic Hero",
    description:
      "A big welcome banner with one clear button, then your details below.",
    sections: ["hero", "about", "services", "contact"],
    // Suits any business; this is the safe default for every category.
    compatibleCategories: "*",
  },
  {
    id: "split-features",
    label: "Split Features",
    description:
      "Two columns showing what you offer side by side. Good when you have many items.",
    sections: ["hero", "feature-grid", "highlights", "contact"],
    compatibleCategories: [
      "online-shop",
      "restaurant",
      "hotel",
      "salon",
      "real-estate",
      "customer-portal",
      "business-profile",
      "custom",
    ],
  },
  {
    id: "magazine",
    label: "Magazine",
    description:
      "A news-style layout with lots of room for stories, updates and photos.",
    sections: ["hero", "story-list", "gallery", "contact"],
    compatibleCategories: [
      "ngo",
      "portfolio",
      "church",
      "school",
      "business-profile",
      "custom",
    ],
  },
  {
    id: "minimal-cards",
    label: "Minimal Cards",
    description: "A clean grid of simple cards. Calm and easy to read.",
    sections: ["hero", "card-grid", "contact"],
    compatibleCategories: [
      "clinic",
      "salon",
      "real-estate",
      "consultant",
      "booking",
      "customer-portal",
      "portfolio",
      "business-profile",
      "custom",
    ],
  },
];

export function isTemplateId(value: string): value is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(value);
}

export function getTemplate(id: string): TemplateManifest | undefined {
  return templates.find((template) => template.id === id);
}

/** True when this layout may be used for this website type. */
export function isTemplateCompatible(
  templateId: string,
  categoryId: string,
): boolean {
  const template = getTemplate(templateId);
  if (!template) return false;
  if (template.compatibleCategories === "*") return true;
  return (template.compatibleCategories as readonly string[]).includes(
    categoryId,
  );
}

/** Every layout offered for a website type. Never empty. */
export function templatesForCategory(categoryId: string): TemplateManifest[] {
  const matches = templates.filter((template) =>
    isTemplateCompatible(template.id, categoryId),
  );
  return matches.length > 0 ? matches : [templates[0]!];
}

/** The layout to fall back to when the chosen one does not suit a new type. */
export function defaultTemplateForCategory(categoryId: string): TemplateId {
  return templatesForCategory(categoryId)[0]!.id;
}

/**
 * Keeps the chosen layout when it still suits the website type, otherwise
 * returns the closest valid one. Switching website type therefore never leaves
 * a draft pointing at an incompatible layout.
 */
export function reconcileTemplate(
  categoryId: string,
  currentTemplateId: string | undefined,
): TemplateId {
  if (currentTemplateId && isTemplateCompatible(currentTemplateId, categoryId))
    return currentTemplateId as TemplateId;
  return defaultTemplateForCategory(categoryId);
}

/** Every website type has at least one layout. Verified by the test suite. */
export function everyCategoryHasATemplate(): boolean {
  return CATEGORY_IDS.every((id) => templatesForCategory(id).length > 0);
}
