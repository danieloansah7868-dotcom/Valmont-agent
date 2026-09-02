import { describe, expect, it } from "vitest";
import {
  buildWebsiteDashboard,
  describeCompletion,
  describeDomain,
  resolveSelectedWebsite,
  SHOP_ORDERS_PATH,
  toWebsiteSummary,
  websitesForOwner,
  websiteEditorPath,
} from "./websites";
import type { DomainRow } from "./domains";
import { createDefaultBrief } from "./site-brief/defaults";
import { siteBriefSchemaV1, type StudioDraft } from "./site-brief/schema";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

function makeDraft(
  id: string,
  ownerId = OWNER_A,
  briefOverrides: Record<string, unknown> = {},
): StudioDraft {
  const brief =
    Object.keys(briefOverrides).length === 0
      ? createDefaultBrief({ businessName: `Client ${id}` })
      : siteBriefSchemaV1.parse({
          ...createDefaultBrief(),
          businessName: `Client ${id}`,
          ...briefOverrides,
        });
  return {
    id,
    ownerId,
    schemaVersion: 1,
    templateRegistryVersion: 1,
    themeRegistryVersion: 1,
    revision: 1,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-02T09:00:00.000Z",
    brief,
  };
}

function domainRow(
  draftId: string,
  ownerId: string,
  status: DomainRow["status"],
): DomainRow {
  return {
    draft_id: draftId,
    owner_id: ownerId,
    hostname: `${draftId}.example.com`,
    status,
    verification_token: "0123456789abcdef0123456789abcdef",
    verified_at: status === "active" ? "2026-08-01T09:00:00.000Z" : null,
    last_checked_at: "2026-08-01T09:00:00.000Z",
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-02T09:00:00.000Z",
  };
}

describe("website summary (one client website card)", () => {
  it("reports the client name, type, layout and theme", () => {
    const summary = toWebsiteSummary(
      makeDraft("site-1", OWNER_A, {
        businessName: "Adom Fashion House",
        category: "online-shop",
        ecomSubcategory: "fashion",
        selectedTemplate: "product-catalogue",
        selectedTheme: "modern-bold",
      }),
    );

    expect(summary.id).toBe("site-1");
    expect(summary.name).toBe("Adom Fashion House");
    expect(summary.typeLabel).toBe("Online Shop & E-Commerce");
    expect(summary.templateLabel).toBe("Product Catalogue");
    expect(summary.themeLabel).toBe("Modern & Bold");
  });

  it("exposes the editor, the preview path and the shop flag", () => {
    const summary = toWebsiteSummary(
      makeDraft("site-2", OWNER_A, {
        payments: { enabled: true, methods: ["valmont_pay"] },
      }),
    );

    expect(summary.editorHref).toBe("/studio/drafts/site-2");
    expect(summary.editorHref).toBe(websiteEditorPath("site-2"));
    expect(summary.previewPath).toBe("/s/site-2");
    expect(summary.hasShop).toBe(true);
    // The order tool stays a separate, owner-scoped page.
    expect(SHOP_ORDERS_PATH).toBe("/studio/orders");
  });

  it("marks a website without checkout as not a shop", () => {
    expect(toWebsiteSummary(makeDraft("site-3")).hasShop).toBe(false);
  });

  it("says so plainly when no layout has been chosen", () => {
    const summary = toWebsiteSummary(
      makeDraft("site-4", OWNER_A, { selectedTemplate: undefined }),
    );
    expect(summary.templateLabel).toBe("No layout chosen yet");
  });

  it("summarises completion in plain words", () => {
    const started = describeCompletion(createDefaultBrief());
    expect(started.readyForHandoff).toBe(false);
    expect(started.missingRequiredCount).toBeGreaterThan(0);
    expect(started.label).toMatch(/required items? left/);
    expect(started.nextStep).toMatch(/^Add /);
    expect(started.score).toBeLessThan(100);

    const finished = describeCompletion(
      siteBriefSchemaV1.parse({
        schemaVersion: 1,
        businessName: "Adom Fabrics",
        category: "business-profile",
        selectedPackage: "starter",
        selectedTheme: "clean-corporate",
        selectedTemplate: "classic-hero",
        adminEmail: "ama@adomfabrics.com",
        phone: "+233201234567",
      }),
    );
    expect(finished.readyForHandoff).toBe(true);
    expect(finished.missingRequiredCount).toBe(0);
    expect(finished.label).toBe("Ready to hand off");
    expect(finished.nextStep).not.toBeNull();
  });

  it("counts exactly one missing required item in the singular", () => {
    // Everything required except a phone or WhatsApp number.
    const almostDone = describeCompletion(
      siteBriefSchemaV1.parse({
        schemaVersion: 1,
        businessName: "Adom Fabrics",
        category: "business-profile",
        selectedPackage: "starter",
        selectedTheme: "clean-corporate",
        adminEmail: "ama@adomfabrics.com",
      }),
    );
    expect(almostDone.missingRequiredCount).toBe(1);
    expect(almostDone.label).toBe("1 required item left");
    expect(almostDone.nextStep).toBe("Add phone or WhatsApp number");
  });

  it("describes every custom-domain state", () => {
    expect(describeDomain().label).toBe("No custom domain yet");
    expect(describeDomain(domainRow("d", OWNER_A, "active"))).toEqual({
      status: "active",
      label: "Custom domain connected",
      hostname: "d.example.com",
    });
    expect(describeDomain(domainRow("d", OWNER_A, "pending")).label).toBe(
      "Custom domain waiting for DNS",
    );
    expect(describeDomain(domainRow("d", OWNER_A, "error")).label).toBe(
      "Custom domain needs fixing",
    );
  });
});

describe("owner isolation on the website dashboard", () => {
  const mine = makeDraft("mine-1");
  const alsoMine = makeDraft("mine-2");
  const foreign = makeDraft("theirs-1", OWNER_B);

  it("keeps only the signed-in owner's drafts", () => {
    const kept = websitesForOwner([mine, foreign, alsoMine], OWNER_A);
    expect(kept.map((draft) => draft.id)).toEqual(["mine-1", "mine-2"]);
  });

  it("builds the switcher from the owner's own websites only", () => {
    const dashboard = buildWebsiteDashboard({
      drafts: [mine, foreign, alsoMine],
      ownerId: OWNER_A,
    });
    expect(dashboard.switcherOptions.map((option) => option.id)).toEqual([
      "mine-1",
      "mine-2",
    ]);
    expect(dashboard.websites.map((site) => site.id)).toEqual([
      "mine-1",
      "mine-2",
    ]);
    expect(
      dashboard.switcherOptions.some(
        (option) => option.name === "Client theirs-1",
      ),
    ).toBe(false);
  });

  it("treats a guessed or foreign website id exactly like no selection", () => {
    const dashboard = buildWebsiteDashboard({
      drafts: [mine, foreign],
      ownerId: OWNER_A,
      requestedWebsiteId: "theirs-1",
    });
    expect(dashboard.selectedWebsite).toBeUndefined();

    const guessed = buildWebsiteDashboard({
      drafts: [mine, foreign],
      ownerId: OWNER_A,
      requestedWebsiteId: "00000000-0000-4000-a000-000000000000",
    });
    expect(guessed.selectedWebsite).toBeUndefined();
  });

  it("selects the owner's own website when the id is theirs", () => {
    const dashboard = buildWebsiteDashboard({
      drafts: [mine, alsoMine, foreign],
      ownerId: OWNER_A,
      requestedWebsiteId: "mine-2",
    });
    expect(dashboard.selectedWebsite?.id).toBe("mine-2");
  });

  it("ignores a domain row that belongs to somebody else", () => {
    const dashboard = buildWebsiteDashboard({
      drafts: [mine],
      ownerId: OWNER_A,
      domains: [domainRow("mine-1", OWNER_B, "active")],
    });
    expect(dashboard.websites[0]?.domain.status).toBe("not_set");
    expect(dashboard.websites[0]?.domain.hostname).toBeUndefined();
  });

  it("attaches the owner's own domain row to the right website", () => {
    const dashboard = buildWebsiteDashboard({
      drafts: [mine, alsoMine],
      ownerId: OWNER_A,
      domains: [domainRow("mine-2", OWNER_A, "active")],
    });
    expect(dashboard.websites[0]?.domain.status).toBe("not_set");
    expect(dashboard.websites[1]?.domain).toEqual({
      status: "active",
      label: "Custom domain connected",
      hostname: "mine-2.example.com",
    });
  });

  it("resolves a selection only from the list it is given", () => {
    const dashboard = buildWebsiteDashboard({
      drafts: [mine],
      ownerId: OWNER_A,
    });
    expect(
      resolveSelectedWebsite(dashboard.websites, foreign.id),
    ).toBeUndefined();
    expect(
      resolveSelectedWebsite(dashboard.websites, undefined),
    ).toBeUndefined();
    expect(resolveSelectedWebsite(dashboard.websites, mine.id)?.id).toBe(
      "mine-1",
    );
  });
});
