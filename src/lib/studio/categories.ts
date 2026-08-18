export const CATEGORY_IDS = [
  "online-shop",
  "business-profile",
  "school",
  "church",
  "restaurant",
  "hotel",
  "salon",
  "clinic",
  "real-estate",
  "ngo",
  "portfolio",
  "consultant",
  "booking",
  "customer-portal",
  "custom",
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const ECOM_SUBCATEGORIES = [
  "fashion",
  "bags-shoes",
  "gadgets",
  "electrical",
  "supermarket",
  "beauty",
  "food",
  "pharmacy",
  "furniture",
  "single-brand",
  "multi-category",
] as const;
export type EcomSubcategoryId = (typeof ECOM_SUBCATEGORIES)[number];

export interface CategoryManifest {
  id: CategoryId;
  label: string;
  description: string;
  ecomSubcategories?: EcomSubcategoryId[];
  requiredPagesHint: string[];
}

export const CATEGORY_REGISTRY_VERSION = 1;

export const categories: CategoryManifest[] = [
  {
    id: "online-shop",
    label: "Online Shop & E-Commerce",
    description: "Sell products online with cart and checkout.",
    requiredPagesHint: [
      "home",
      "shop",
      "product",
      "cart",
      "checkout",
      "contact",
    ],
  },
  {
    id: "business-profile",
    label: "Business & Company Profile",
    description: "Show who you are and what you do.",
    requiredPagesHint: ["home", "about", "services", "contact"],
  },
  {
    id: "school",
    label: "School & Education",
    description: "Admissions, programmes, events and calendar.",
    requiredPagesHint: [
      "home",
      "about",
      "programmes",
      "admissions",
      "events",
      "contact",
    ],
  },
  {
    id: "church",
    label: "Church & Ministry",
    description: "Service times, sermons and events.",
    requiredPagesHint: [
      "home",
      "about",
      "ministries",
      "sermons",
      "events",
      "contact",
    ],
  },
  {
    id: "restaurant",
    label: "Restaurant & Food Ordering",
    description: "Menu, reservations and delivery or pickup.",
    requiredPagesHint: ["home", "menu", "reservations", "contact"],
  },
  {
    id: "hotel",
    label: "Hotel & Accommodation",
    description: "Rooms, amenities and booking requests.",
    requiredPagesHint: ["home", "rooms", "amenities", "booking", "contact"],
  },
  {
    id: "salon",
    label: "Salon, Barber & Spa",
    description: "Services, gallery and appointments.",
    requiredPagesHint: ["home", "services", "gallery", "booking", "contact"],
  },
  {
    id: "clinic",
    label: "Clinic & Pharmacy",
    description: "Services, hours and appointment requests.",
    requiredPagesHint: ["home", "services", "contact"],
  },
  {
    id: "real-estate",
    label: "Real Estate & Property",
    description: "Property listings and enquiries.",
    requiredPagesHint: ["home", "properties", "contact"],
  },
  {
    id: "ngo",
    label: "NGO & Non-Profit",
    description: "Mission, programmes and donations.",
    requiredPagesHint: ["home", "about", "programmes", "contact"],
  },
  {
    id: "portfolio",
    label: "Personal Portfolio",
    description: "Show your work and skills.",
    requiredPagesHint: ["home", "about", "projects", "contact"],
  },
  {
    id: "consultant",
    label: "Consultant & Professional Services",
    description: "Services, expertise and contact.",
    requiredPagesHint: ["home", "about", "services", "contact"],
  },
  {
    id: "booking",
    label: "Appointment & Booking Business",
    description: "Availability and booking forms.",
    requiredPagesHint: ["home", "services", "booking", "contact"],
  },
  {
    id: "customer-portal",
    label: "Customer Portal & Web App",
    description: "Member area or dashboard.",
    requiredPagesHint: ["home", "features", "contact"],
  },
  {
    id: "custom",
    label: "Custom Website",
    description: "Tell us what you need — we will adapt.",
    requiredPagesHint: ["home", "about", "contact"],
  },
];

export function isCategoryId(v: string): v is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(v);
}
/** Human wording for a shop subtype, e.g. "bags-shoes" -> "Bags & shoes". */
export function ecomSubcategoryLabel(id: EcomSubcategoryId): string {
  const words = id.replace(/-/g, " & ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function isEcomSubcategoryId(v: string): v is EcomSubcategoryId {
  return (ECOM_SUBCATEGORIES as readonly string[]).includes(v);
}

export function getCategory(id: string): CategoryManifest | undefined {
  return categories.find((category) => category.id === id);
}
