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
  compatibleCategories: string[];
}
export const TEMPLATE_REGISTRY_VERSION = 1;
export const templates: TemplateManifest[] = [
  {
    id: "classic-hero",
    label: "Classic Hero",
    description: "Large hero with call to action",
    compatibleCategories: ["business-profile", "school", "church"],
  },
  {
    id: "split-features",
    label: "Split Features",
    description: "Two-column feature grid",
    compatibleCategories: ["online-shop", "restaurant", "hotel"],
  },
  {
    id: "magazine",
    label: "Magazine",
    description: "Content-heavy listing",
    compatibleCategories: ["ngo", "portfolio"],
  },
  {
    id: "minimal-cards",
    label: "Minimal Cards",
    description: "Card grid, very clean",
    compatibleCategories: [
      "clinic",
      "salon",
      "real-estate",
      "consultant",
      "booking",
      "customer-portal",
      "custom",
    ],
  },
];
export function isTemplateId(v: string): v is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(v);
}
