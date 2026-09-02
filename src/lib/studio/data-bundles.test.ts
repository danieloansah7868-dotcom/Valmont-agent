import { describe, expect, it } from "vitest";
import {
  autoBundleName,
  dataBundleSchema,
  dataNetworkLabel,
  groupBundlesByNetwork,
  isValidBundleRecipientPhone,
  normalizeVolume,
  parseDataBundleText,
} from "./data-bundles";

describe("normalizeVolume", () => {
  it("normalizes GB and MB", () => {
    expect(normalizeVolume("2GB")).toBe("2GB");
    expect(normalizeVolume("2 gb")).toBe("2GB");
    expect(normalizeVolume("500MB")).toBe("500MB");
    expect(normalizeVolume(" 2.5 GB ")).toBe("2.50GB");
    expect(normalizeVolume("1.00GB")).toBe("1GB");
  });

  it("rejects invalid volumes", () => {
    expect(normalizeVolume("")).toBeNull();
    expect(normalizeVolume("abc")).toBeNull();
    expect(normalizeVolume("-1GB")).toBeNull();
  });
});

describe("dataBundleSchema", () => {
  it("accepts a valid bundle", () => {
    const parsed = dataBundleSchema.safeParse({
      id: "bundle-1",
      network: "mtn",
      volume: "2GB",
      validityDays: 30,
      price: 15,
      name: "MTN 2GB - 30 days",
      active: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid network", () => {
    const parsed = dataBundleSchema.safeParse({
      id: "bundle-1",
      network: "invalid",
      volume: "2GB",
      validityDays: 30,
      price: 15,
      name: "Test",
      active: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid volume", () => {
    const parsed = dataBundleSchema.safeParse({
      id: "bundle-1",
      network: "mtn",
      volume: "not-a-volume",
      validityDays: 30,
      price: 15,
      name: "Test",
      active: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid validity", () => {
    const parsed = dataBundleSchema.safeParse({
      id: "bundle-1",
      network: "mtn",
      volume: "2GB",
      validityDays: 400,
      price: 15,
      name: "Test",
      active: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("autoBundleName", () => {
  it("generates human names", () => {
    expect(
      autoBundleName({ network: "mtn", volume: "2GB", validityDays: 30 }),
    ).toBe("MTN 2GB - 30 days");
    expect(
      autoBundleName({ network: "telecel", volume: "5GB", validityDays: 1 }),
    ).toBe("Telecel 5GB - 1 day");
  });
});

describe("parseDataBundleText", () => {
  it("parses simple lines with price", () => {
    const bundles = parseDataBundleText("MTN 2GB - 15\nTelecel 5GB - 35");
    expect(bundles).toHaveLength(2);
    expect(bundles[0].network).toBe("mtn");
    expect(bundles[0].volume).toBe("2GB");
    expect(bundles[0].price).toBe(15);
    expect(bundles[1].network).toBe("telecel");
    expect(bundles[1].volume).toBe("5GB");
    expect(bundles[1].price).toBe(35);
  });

  it("detects validity", () => {
    const bundles = parseDataBundleText("MTN 2GB 7days - 10");
    expect(bundles[0].validityDays).toBe(7);
  });

  it("defaults network to mtn", () => {
    const bundles = parseDataBundleText("2GB - 15");
    expect(bundles[0].network).toBe("mtn");
    expect(bundles[0].volume).toBe("2GB");
  });
});

describe("groupBundlesByNetwork", () => {
  it("groups and sorts by price", () => {
    const bundles = [
      {
        id: "1",
        network: "mtn" as const,
        volume: "5GB",
        validityDays: 30,
        price: 30,
        name: "MTN 5GB",
        active: true,
      },
      {
        id: "2",
        network: "mtn" as const,
        volume: "1GB",
        validityDays: 30,
        price: 10,
        name: "MTN 1GB",
        active: true,
      },
      {
        id: "3",
        network: "telecel" as const,
        volume: "2GB",
        validityDays: 30,
        price: 20,
        name: "Telecel 2GB",
        active: true,
      },
    ];
    const grouped = groupBundlesByNetwork(bundles);
    expect(grouped.mtn).toHaveLength(2);
    expect(grouped.mtn[0].price).toBe(10);
    expect(grouped.mtn[1].price).toBe(30);
    expect(grouped.telecel).toHaveLength(1);
  });

  it("excludes inactive bundles", () => {
    const bundles = [
      {
        id: "1",
        network: "mtn" as const,
        volume: "1GB",
        validityDays: 30,
        price: 10,
        name: "MTN 1GB",
        active: false,
      },
    ];
    const grouped = groupBundlesByNetwork(bundles);
    expect(grouped.mtn).toHaveLength(0);
  });
});

describe("isValidBundleRecipientPhone", () => {
  it("accepts Ghana numbers", () => {
    expect(isValidBundleRecipientPhone("0241234567")).toBe(true);
    expect(isValidBundleRecipientPhone("+233241234567")).toBe(true);
    expect(isValidBundleRecipientPhone("233241234567")).toBe(true);
  });

  it("rejects invalid numbers", () => {
    expect(isValidBundleRecipientPhone("123")).toBe(false);
    expect(isValidBundleRecipientPhone("")).toBe(false);
    expect(isValidBundleRecipientPhone("024123")).toBe(false);
  });
});

describe("dataNetworkLabel", () => {
  it("returns label", () => {
    expect(dataNetworkLabel("mtn")).toBe("MTN");
    expect(dataNetworkLabel("telecel")).toBe("Telecel");
  });
});
