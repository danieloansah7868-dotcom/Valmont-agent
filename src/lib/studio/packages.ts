export const PACKAGE_IDS = ["lite", "starter", "business", "empire"] as const;
export type PackageId = (typeof PACKAGE_IDS)[number];

export interface PackagePreset {
  id: PackageId;
  label: string;
  limits: {
    maxPages: number;
    maxProducts: number;
    maxImagesPerProduct: number;
    storageMB: number;
  };
  capabilities: {
    admin: boolean;
    ecommerce: boolean;
    bookings: boolean;
    blog: boolean;
    multiLang: boolean;
    analytics: boolean;
    payments: boolean;
  };
  notes: string;
}

export const PACKAGE_REGISTRY_VERSION = 1;

export const packages: PackagePreset[] = [
  {
    id: "lite",
    label: "Lite",
    limits: {
      maxPages: 5,
      maxProducts: 20,
      maxImagesPerProduct: 3,
      storageMB: 500,
    },
    capabilities: {
      admin: false,
      ecommerce: false,
      bookings: false,
      blog: false,
      multiLang: false,
      analytics: false,
      payments: false,
    },
    notes: "Starter presence — limited pages, no store.",
  },
  {
    id: "starter",
    label: "Starter",
    limits: {
      maxPages: 10,
      maxProducts: 50,
      maxImagesPerProduct: 4,
      storageMB: 1000,
    },
    capabilities: {
      admin: true,
      ecommerce: false,
      bookings: true,
      blog: true,
      multiLang: false,
      analytics: true,
      payments: false,
    },
    notes: "Small business with admin and bookings.",
  },
  {
    id: "business",
    label: "Business",
    limits: {
      maxPages: 25,
      maxProducts: 500,
      maxImagesPerProduct: 6,
      storageMB: 5000,
    },
    capabilities: {
      admin: true,
      ecommerce: true,
      bookings: true,
      blog: true,
      multiLang: true,
      analytics: true,
      payments: true,
    },
    notes:
      "Full e-commerce and bookings. Quotas reflect provider limits, not unlimited resources.",
  },
  {
    id: "empire",
    label: "Empire / Custom",
    limits: {
      maxPages: 100,
      maxProducts: 5000,
      maxImagesPerProduct: 8,
      storageMB: 20000,
    },
    capabilities: {
      admin: true,
      ecommerce: true,
      bookings: true,
      blog: true,
      multiLang: true,
      analytics: true,
      payments: true,
    },
    notes: "Large catalogue — discuss infrastructure before launch.",
  },
];

export function isPackageId(v: string): v is PackageId {
  return (PACKAGE_IDS as readonly string[]).includes(v);
}
