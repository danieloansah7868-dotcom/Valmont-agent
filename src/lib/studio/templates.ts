import {
  CATEGORY_IDS,
  type CategoryId,
  categories as categoryManifests,
} from "./categories";

export const TEMPLATE_IDS = [
  "classic-hero",
  "split-features",
  "magazine",
  "minimal-cards",
  "destination-showcase",
  "tour-booking",
  "luxury-escape",
  "product-catalogue",
  "bundle-shop",
  "service-showcase",
  "booking-journey",
  "property-collection",
  "campus-life",
  "ministry-community",
  "impact-story",
  "creative-case-studies",
  "professional-profile",
  "member-hub",
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

export const TEMPLATE_REGISTRY_VERSION = 2;

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
      "travel-tourism",
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
      "travel-tourism",
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
      "travel-tourism",
      "custom",
    ],
  },
  {
    id: "destination-showcase",
    label: "Destination Showcase",
    description:
      "Large destination photos with featured trips and a clear enquiry button.",
    sections: ["hero", "gallery", "feature-grid", "contact"],
    compatibleCategories: ["travel-tourism", "hotel"],
  },
  {
    id: "tour-booking",
    label: "Tour Booking",
    description:
      "A practical tours layout for packages, itineraries and booking requests.",
    sections: ["hero", "services", "highlights", "booking", "contact"],
    compatibleCategories: ["travel-tourism", "hotel", "booking"],
  },
  {
    id: "luxury-escape",
    label: "Luxury Escape",
    description:
      "A refined, image-led layout for premium stays, retreats and experiences.",
    sections: ["hero", "about", "gallery", "highlights", "contact"],
    compatibleCategories: ["travel-tourism", "hotel"],
  },
  {
    id: "product-catalogue",
    label: "Product Catalogue",
    description:
      "A product-first layout with featured items, categories and a clear order button.",
    sections: ["hero", "card-grid", "highlights", "contact"],
    compatibleCategories: ["online-shop", "restaurant", "clinic"],
  },
  {
    id: "bundle-shop",
    label: "Bundle Shop",
    description:
      "Network tabs for MTN, Telecel and AirtelTigo with instant bundle delivery.",
    sections: ["hero", "bundle-grid", "how-it-works", "contact"],
    compatibleCategories: ["data-bundles"],
  },
  {
    id: "service-showcase",
    label: "Service Showcase",
    description:
      "A confident services layout with benefits, testimonials and a contact call to action.",
    sections: ["hero", "services", "highlights", "contact"],
    compatibleCategories: [
      "business-profile",
      "consultant",
      "salon",
      "clinic",
      "custom",
    ],
  },
  {
    id: "booking-journey",
    label: "Booking Journey",
    description:
      "Lead visitors from an offer to availability, booking and contact in clear steps.",
    sections: ["hero", "services", "booking", "contact"],
    compatibleCategories: ["hotel", "travel-tourism", "salon", "booking"],
  },
  {
    id: "property-collection",
    label: "Property Collection",
    description:
      "A listing-led layout for homes, land, rentals and property enquiries.",
    sections: ["hero", "card-grid", "gallery", "contact"],
    compatibleCategories: ["real-estate"],
  },
  {
    id: "campus-life",
    label: "Campus Life",
    description:
      "An education layout for programmes, admissions, events and school stories.",
    sections: ["hero", "programmes", "events", "contact"],
    compatibleCategories: ["school"],
  },
  {
    id: "ministry-community",
    label: "Ministry & Community",
    description:
      "A welcoming church layout for service times, ministries, sermons and events.",
    sections: ["hero", "ministries", "story-list", "events", "contact"],
    compatibleCategories: ["church"],
  },
  {
    id: "impact-story",
    label: "Impact Story",
    description:
      "A mission-focused layout for programmes, outcomes, supporters and donations.",
    sections: ["hero", "about", "programmes", "highlights", "contact"],
    compatibleCategories: ["ngo"],
  },
  {
    id: "creative-case-studies",
    label: "Creative Case Studies",
    description:
      "Put selected work, before-and-after stories and client results at the centre.",
    sections: ["hero", "projects", "gallery", "contact"],
    compatibleCategories: ["portfolio", "business-profile", "custom"],
  },
  {
    id: "professional-profile",
    label: "Professional Profile",
    description:
      "A focused personal or expert profile with credentials, services and contact.",
    sections: ["hero", "about", "services", "contact"],
    compatibleCategories: ["consultant", "portfolio", "business-profile"],
  },
  {
    id: "member-hub",
    label: "Member Hub",
    description:
      "A structured layout for member benefits, features, help and sign-in information.",
    sections: ["hero", "features", "highlights", "contact"],
    compatibleCategories: ["customer-portal"],
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
  const manifest = categoryManifests.find((c) => c.id === categoryId);
  if (manifest?.preferredTemplate) {
    const pref = manifest.preferredTemplate;
    if (isTemplateCompatible(pref, categoryId)) {
      return pref as TemplateId;
    }
  }
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
