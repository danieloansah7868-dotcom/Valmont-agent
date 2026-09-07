import { describe, expect, it } from "vitest";
import {
  can,
  isShopPermission,
  MAX_SHOP_LOGINS_PER_WEBSITE,
  parsePermissions,
  RESERVED_SHOP_PERMISSION,
  serializePermissions,
  SHOP_PERMISSION_LABELS,
  SHOP_PERMISSIONS,
} from "./permissions";

describe("SHOP_PERMISSIONS", () => {
  it("is exactly the four Stage 6b boxes, each with a plain-language label", () => {
    expect([...SHOP_PERMISSIONS]).toEqual([
      "orders.fulfil",
      "bundles.manage",
      "supplier.manage",
      "reports.view",
    ]);
    expect(SHOP_PERMISSION_LABELS).toEqual({
      "orders.fulfil": "Deliver orders",
      "bundles.manage": "Pause bundles & change prices",
      "supplier.manage": "Supplier & float",
      "reports.view": "Sales & margin",
    });
  });

  it("caps a website at ten logins", () => {
    expect(MAX_SHOP_LOGINS_PER_WEBSITE).toBe(10);
  });

  it("never lists the reserved wallet permission", () => {
    expect(RESERVED_SHOP_PERMISSION).toBe("wallets.topup");
    expect(isShopPermission(RESERVED_SHOP_PERMISSION)).toBe(false);
  });
});

describe("parsePermissions", () => {
  it("accepts a JSON column and keeps only known ids in canonical order", () => {
    expect(
      parsePermissions('["reports.view","orders.fulfil","reports.view"]'),
    ).toEqual(["orders.fulfil", "reports.view"]);
  });

  it("accepts an array and drops anything not on the allow-list", () => {
    expect(
      parsePermissions([
        "bundles.manage",
        "wallets.topup",
        "admin",
        "orders.*",
        42,
        null,
        { id: "orders.fulfil" },
      ]),
    ).toEqual(["bundles.manage"]);
  });

  it("fails closed on malformed input", () => {
    expect(parsePermissions("not json")).toEqual([]);
    expect(parsePermissions('{"orders.fulfil":true}')).toEqual([]);
    expect(parsePermissions(undefined)).toEqual([]);
    expect(parsePermissions(null)).toEqual([]);
    expect(parsePermissions(7)).toEqual([]);
  });

  it("serialises to the same canonical JSON regardless of input order", () => {
    expect(serializePermissions(["reports.view", "orders.fulfil"])).toBe(
      serializePermissions(["orders.fulfil", "reports.view"]),
    );
    expect(serializePermissions(["wallets.topup"])).toBe("[]");
  });
});

describe("can", () => {
  const owner = { role: "owner" as const, permissions: [] };
  const member = {
    role: "member" as const,
    permissions: ["orders.fulfil"],
  };

  it("lets the owner do everything on the list", () => {
    for (const permission of SHOP_PERMISSIONS) {
      expect(can(owner, permission)).toBe(true);
    }
  });

  it("lets a member do exactly what was ticked", () => {
    expect(can(member, "orders.fulfil")).toBe(true);
    expect(can(member, "bundles.manage")).toBe(false);
    expect(can(member, "supplier.manage")).toBe(false);
    expect(can(member, "reports.view")).toBe(false);
  });

  it("never grants the reserved wallet permission — not even to the owner", () => {
    expect(can(owner, RESERVED_SHOP_PERMISSION)).toBe(false);
    expect(
      can(
        { role: "member", permissions: [RESERVED_SHOP_PERMISSION] },
        RESERVED_SHOP_PERMISSION,
      ),
    ).toBe(false);
  });

  it("rejects unknown permission ids and missing admins", () => {
    expect(can(owner, "orders.delete")).toBe(false);
    expect(can(null, "orders.fulfil")).toBe(false);
    expect(can(undefined, "orders.fulfil")).toBe(false);
  });

  it("ignores stray values a member row might carry", () => {
    const messy = {
      role: "member" as const,
      permissions: ["wallets.topup", "reports.view", "nonsense"],
    };
    expect(can(messy, "reports.view")).toBe(true);
    expect(can(messy, "wallets.topup")).toBe(false);
  });
});
