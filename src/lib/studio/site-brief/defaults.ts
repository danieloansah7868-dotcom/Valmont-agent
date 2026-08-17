import type { SiteBriefV1 } from "./schema";

export const ghanaDefaults: Partial<SiteBriefV1> = {
  preferredLanguage: "en",
};

export function applyGhanaDefaults(
  brief: Partial<SiteBriefV1>,
): Partial<SiteBriefV1> {
  return { ...ghanaDefaults, ...brief };
}

export function createDefaultBrief(): SiteBriefV1 {
  return {
    schemaVersion: 1,
    businessName: "",
    category: "business-profile" as const,
    socialLinks: [],
    serviceAreas: [],
    deliveryAreas: [],
    services: [],
    requiredPages: [],
    selectedPackage: "starter" as const,
    selectedTheme: "clean-corporate" as const,
    adminEmail: "",
    assetStatus: "not_provided",
  } as unknown as SiteBriefV1;
}
