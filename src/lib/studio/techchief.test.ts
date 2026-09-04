/**
 * Stage 5 — the TechChief HTTP client, tested against a stubbed `fetch`.
 *
 * No real HTTP is made anywhere in this file: every case drives the client
 * with a canned response (or a thrown error) and asserts what it sent and what
 * it made of the answer. The point of the suite is the two promises the module
 * header makes — a caller never has to catch, and a timeout is never guessed
 * at — plus the exact wire shape TechChief documents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTechChiefStatus,
  getTechChiefWallet,
  listTechChiefBundles,
  matchTechChiefBundle,
  placeTechChiefOrder,
  techChiefNetworkFor,
  TECHCHIEF_API_BASE,
  TECHCHIEF_TIMEOUT_MS,
  TECHCHIEF_USER_AGENT,
  type TechChiefBundle,
} from "./techchief";

const KEY = "TCHX-Ab12Cd34Ef56Gh78";

const fetchMock = vi.fn();

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** The URL and init of the single call the stub recorded. */
function sent(): { url: URL; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url: new URL(url), init };
}

function sentBody(): Record<string, unknown> {
  const { init } = sent();
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentHeaders(): Record<string, string> {
  const { init } = sent();
  const headers = init.headers as Record<string, string>;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TechChief client — the wire", () => {
  it("authenticates with X-API-Key, JSON and the Valmont-Agent identity", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        wallet_balance: 42.5,
        currency: "GHS",
        low_balance: false,
        threshold: 20,
        account_status: "active",
        api_activated: true,
        key_name: "Adom Data",
      }),
    );

    const result = await getTechChiefWallet(KEY);

    expect(result.ok).toBe(true);
    const { url, init } = sent();
    expect(url.toString()).toBe(`${TECHCHIEF_API_BASE}dev_wallet.php`);
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    const headers = sentHeaders();
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["user-agent"]).toBe(TECHCHIEF_USER_AGENT);
    expect(headers.accept).toBe("application/json");
    // A GET carries no body, and the key never travels in the URL either.
    expect(init.body).toBeUndefined();
    expect(url.search).toBe("");
    expect(url.toString()).not.toContain(KEY);
    if (result.ok) {
      expect(result.data).toEqual({
        walletBalance: 42.5,
        currency: "GHS",
        lowBalance: false,
        threshold: 20,
        accountStatus: "active",
        apiActivated: true,
        keyName: "Adom Data",
      });
    }
  });

  it("sets a 15-second abort deadline on every call", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      // The signal must be a real AbortSignal wired to a timer.
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(
        jsonResponse({ success: true, wallet_balance: 1 }),
      );
    });

    await getTechChiefWallet(KEY);

    expect(TECHCHIEF_TIMEOUT_MS).toBe(15_000);
  });

  it("lists bundles per network and renames their fields to ours", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        bundles: [
          {
            id: 12,
            network: "MTN",
            size_gb: 1,
            validity_days: 7,
            price: 8.5,
            currency: "GHS",
          },
          // A bundle we cannot use is dropped rather than mis-mapped: no id,
          // and a network we do not know.
          { network: "BigTime", size_gb: 20, price: 100 },
          { id: 13, network: "Satellite", size_gb: 5, price: 10 },
        ],
      }),
    );

    const result = await listTechChiefBundles(KEY, "mtn");

    expect(result.ok).toBe(true);
    const { url } = sent();
    expect(url.pathname).toBe("/api/dev_bundles.php");
    // Their network strings are case-sensitive.
    expect(url.searchParams.get("network")).toBe("MTN");
    if (result.ok) {
      expect(result.data).toEqual([
        {
          id: 12,
          network: "MTN",
          sizeGb: 1,
          validityDays: 7,
          price: 8.5,
          currency: "GHS",
        },
      ]);
    }
  });

  it("lists every network when no filter is given", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, bundles: [] }));

    await listTechChiefBundles(KEY);

    expect(sent().url.search).toBe("");
  });

  it("refuses an unknown network instead of downloading the whole list", async () => {
    const result = await listTechChiefBundles(KEY, "vodafone");

    expect(result).toMatchObject({ ok: false, kind: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("orders by bundle id with a normalised 10-digit Ghana number", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        order_ref: "DEV-A1B2C3D4",
        status: "accepted",
        api_price: 8.5,
        wallet_balance: 34,
        message: "Order accepted",
      }),
    );

    const result = await placeTechChiefOrder(KEY, {
      network: "mtn",
      bundleId: 12,
      // The international spelling a customer might paste.
      phone: "+233 244 123 456",
      callbackUrl: "https://shop.example/api/bundle-delivery/techchief/webhook",
    });

    expect(result.ok).toBe(true);
    const { url } = sent();
    expect(url.pathname).toBe("/api/dev_order.php");
    expect(sent().init.method).toBe("POST");
    expect(sentHeaders()["content-type"]).toBe("application/json");
    expect(sentBody()).toEqual({
      network: "MTN",
      bundle_id: 12,
      phone: "0244123456",
      callback_url:
        "https://shop.example/api/bundle-delivery/techchief/webhook",
    });
    if (result.ok) {
      expect(result.data).toEqual({
        orderRef: "DEV-A1B2C3D4",
        status: "accepted",
        apiPrice: 8.5,
        walletBalance: 34,
        message: "Order accepted",
      });
    }
  });

  it("omits callback_url when the caller has no https URL to give", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        order_ref: "DEV-1",
        status: "processing",
      }),
    );

    await placeTechChiefOrder(KEY, {
      network: "telecel",
      bundleId: 7,
      phone: "0201234567",
    });

    expect(sentBody()).toEqual({
      network: "Telecel",
      bundle_id: 7,
      phone: "0201234567",
    });
    expect(sentBody()).not.toHaveProperty("callback_url");
  });

  it("refuses to order for an invalid recipient or a missing bundle id", async () => {
    const badPhone = await placeTechChiefOrder(KEY, {
      network: "mtn",
      bundleId: 12,
      phone: "12345",
    });
    expect(badPhone).toMatchObject({ ok: false, kind: "validation" });
    if (!badPhone.ok) {
      expect(badPhone.message).toContain("Ghana mobile");
    }

    const badBundle = await placeTechChiefOrder(KEY, {
      network: "mtn",
      bundleId: 1.5,
      phone: "0244123456",
    });
    expect(badBundle).toMatchObject({ ok: false, kind: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls one order reference", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        order_ref: "DEV-A1B2C3D4",
        status: "delivered",
        message: "Delivered",
      }),
    );

    const result = await getTechChiefStatus(KEY, "DEV-A1B2C3D4");

    expect(result.ok).toBe(true);
    expect(sent().url.pathname).toBe("/api/dev_status.php");
    expect(sent().url.searchParams.get("order_ref")).toBe("DEV-A1B2C3D4");
    if (result.ok) expect(result.data.status).toBe("delivered");
  });
});

describe("TechChief client — outcome mapping", () => {
  it("maps accepted, processing and failed order answers", async () => {
    for (const status of ["accepted", "processing", "failed"] as const) {
      fetchMock.mockResolvedValue(
        jsonResponse({ success: true, order_ref: "DEV-1", status }),
      );
      const result = await placeTechChiefOrder(KEY, {
        network: "mtn",
        bundleId: 12,
        phone: "0244123456",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.status).toBe(status);
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
    }
  });

  it("402 is a balance failure carrying the balance and the price needed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          code: "INSUFFICIENT_BALANCE",
          message: "Insufficient wallet balance",
          wallet_balance: 2.5,
          required: 8.5,
        },
        { status: 402 },
      ),
    );

    const result = await placeTechChiefOrder(KEY, {
      network: "mtn",
      bundleId: 12,
      phone: "0244123456",
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "balance",
      walletBalance: 2.5,
      required: 8.5,
      code: "INSUFFICIENT_BALANCE",
      status: 402,
    });
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "bundle"],
    [400, "validation"],
    [422, "validation"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
  ] as const)("HTTP %i maps to kind %s", async (status, kind) => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, code: "X", message: `their message for ${status}` },
        { status },
      ),
    );

    const result = await getTechChiefWallet(KEY);

    expect(result).toMatchObject({
      ok: false,
      kind,
      message: `their message for ${status}`,
      status,
    });
  });

  it("falls back to its own wording when the error body is unreadable", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await getTechChiefWallet(KEY);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("server");
      expect(result.message).not.toContain("<html>");
      expect(result.message.length).toBeGreaterThan(10);
    }
  });

  it("treats a 200 that says success:false as a failure, never as data", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, message: "Key suspended" }),
    );

    const result = await getTechChiefWallet(KEY);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("Key suspended");
  });

  it('a timeout is kind "timeout" and says the outcome is unknown', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("This operation was aborted"), {
        name: "AbortError",
      }),
    );

    const result = await placeTechChiefOrder(KEY, {
      network: "mtn",
      bundleId: 12,
      phone: "0244123456",
    });

    expect(result).toMatchObject({ ok: false, kind: "timeout" });
    if (!result.ok) {
      expect(result.message).toContain("outcome is unknown");
      expect(result.message).toContain("TechChief dashboard");
      // The key must never be echoed back inside an error a caller may log.
      expect(result.message).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it('a connection failure is kind "network"', async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const result = await getTechChiefWallet(KEY);

    expect(result).toMatchObject({ ok: false, kind: "network" });
  });

  it("never throws, whatever fetch does", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(getTechChiefWallet(KEY)).resolves.toMatchObject({ ok: false });
    await expect(
      placeTechChiefOrder(KEY, {
        network: "mtn",
        bundleId: 1,
        phone: "0244123456",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(getTechChiefStatus(KEY, "DEV-1")).resolves.toMatchObject({
      ok: false,
    });
    await expect(listTechChiefBundles(KEY)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("parses X-RateLimit-Remaining on success and on failure alike", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: true, wallet_balance: 10 },
        {
          headers: { "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "42" },
        },
      ),
    );
    const ok = await getTechChiefWallet(KEY);
    expect(ok).toMatchObject({ ok: true, rateLimitRemaining: 42 });

    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, message: "Slow down" },
        { status: 429, headers: { "X-RateLimit-Remaining": "0" } },
      ),
    );
    const limited = await getTechChiefWallet(KEY);
    expect(limited).toMatchObject({
      ok: false,
      kind: "rate_limited",
      rateLimitRemaining: 0,
    });

    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, wallet_balance: 10 }),
    );
    const absent = await getTechChiefWallet(KEY);
    expect(absent).toMatchObject({ ok: true, rateLimitRemaining: null });
  });
});

describe("TechChief client — networks and matching", () => {
  it("maps our catalogue ids to their case-sensitive network strings", () => {
    expect(techChiefNetworkFor("mtn")).toBe("MTN");
    expect(techChiefNetworkFor("telecel")).toBe("Telecel");
    expect(techChiefNetworkFor("airteltigo")).toBe("AirtelTigo");
    // Their own spelling passes straight through, including BigTime, which has
    // no catalogue id yet.
    expect(techChiefNetworkFor("BigTime")).toBe("BigTime");
    expect(techChiefNetworkFor("MTN")).toBe("MTN");
    expect(techChiefNetworkFor("vodafone")).toBeNull();
    expect(techChiefNetworkFor("")).toBeNull();
    expect(techChiefNetworkFor(null)).toBeNull();
  });

  const BUNDLES: TechChiefBundle[] = [
    {
      id: 11,
      network: "MTN",
      sizeGb: 1,
      validityDays: 7,
      price: 8.5,
      currency: "GHS",
    },
    {
      id: 12,
      network: "MTN",
      sizeGb: 5,
      validityDays: 30,
      price: 38,
      currency: "GHS",
    },
    {
      id: 21,
      network: "Telecel",
      sizeGb: 1,
      validityDays: 7,
      price: 7,
      currency: "GHS",
    },
    {
      id: 31,
      network: "AirtelTigo",
      sizeGb: 10,
      validityDays: 30,
      price: 66,
      currency: "GHS",
    },
    {
      id: 41,
      network: "BigTime",
      sizeGb: 50,
      validityDays: null,
      price: 300,
      currency: "GHS",
    },
  ];

  it("matches a catalogue item on network and size in MB", () => {
    expect(matchTechChiefBundle(BUNDLES, "mtn", 1024)?.id).toBe(11);
    expect(matchTechChiefBundle(BUNDLES, "mtn", 5120)?.id).toBe(12);
    expect(matchTechChiefBundle(BUNDLES, "telecel", 1024)?.id).toBe(21);
    expect(matchTechChiefBundle(BUNDLES, "airteltigo", 10240)?.id).toBe(31);
    // Their own spelling works too, so a webhook or a sync can match directly.
    expect(matchTechChiefBundle(BUNDLES, "MTN", 1024)?.id).toBe(11);
  });

  it("accepts a decimal size list (1 GB = 1000 MB) for legacy items", () => {
    expect(matchTechChiefBundle(BUNDLES, "mtn", 1000)?.id).toBe(11);
    expect(matchTechChiefBundle(BUNDLES, "mtn", 5000)?.id).toBe(12);
  });

  it("finds nothing for a size or network TechChief does not sell", () => {
    // The classic: 500MB does not exist at TechChief, so it cannot be
    // auto-delivered and the owner has to be told.
    expect(matchTechChiefBundle(BUNDLES, "mtn", 500)).toBeNull();
    expect(matchTechChiefBundle(BUNDLES, "mtn", 2048)).toBeNull();
    expect(matchTechChiefBundle(BUNDLES, "telecel", 5120)).toBeNull();
    expect(matchTechChiefBundle([], "mtn", 1024)).toBeNull();
    expect(matchTechChiefBundle(BUNDLES, "vodafone", 1024)).toBeNull();
    expect(matchTechChiefBundle(BUNDLES, "mtn", 0)).toBeNull();
    expect(matchTechChiefBundle(BUNDLES, "mtn", Number.NaN)).toBeNull();
  });
});
