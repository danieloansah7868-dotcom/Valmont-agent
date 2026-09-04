/**
 * Stage 5 — the TechChief delivery callback.
 *
 * The endpoint is unauthenticated by nature (TechChief calls it, not a
 * browser), so the whole test suite is about what it trusts. With a webhook
 * secret the signature over the RAW body is the trust; without one the payload
 * is a rumour that must be confirmed against TechChief before a row changes.
 * Either way the engine's row rules hold: delivered is terminal, an unknown or
 * foreign reference changes nothing, and a replay is a no-op.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { canonicalUserId } from "@/lib/user-identity";
import { POST } from "./route";
import {
  SqliteBundleDeliveriesStore,
  type NewBundleDeliveryInput,
} from "@/lib/studio/bundle-delivery";
import { SqliteIntegrationsStore } from "@/lib/studio/integrations";
import { SqliteOrdersStore, type NewOrderInput } from "@/lib/studio/orders";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { encryptSessionValue } from "@/lib/security";

const SECRET = "whsec-test-secret-value";
const KEY = "TCHX-Ab12Cd34Ef56Gh78";
const userA: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const userB: SessionUser = { id: "9002", login: "kofi", name: "Kofi" };
const OWNER_A = canonicalUserId(userA);
const OWNER_B = canonicalUserId(userB);
const ORDER_REF = "DEV-A1B2C3D4";

const dirs: string[] = [];
let orders: SqliteOrdersStore;
let deliveries: SqliteBundleDeliveriesStore;
let integrations: SqliteIntegrationsStore;
let drafts: SqliteStudioDraftStore;
const fetchMock = vi.fn();
let statusCalls = 0;
/** What dev_status.php answers when the unsigned path confirms a payload. */
let confirmedStatus = "delivered";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sign(rawBody: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-tch-webhook-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  vi.stubEnv("APP_URL", "https://shop.example");
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;

  orders = new SqliteOrdersStore();
  deliveries = new SqliteBundleDeliveriesStore();
  integrations = new SqliteIntegrationsStore();
  drafts = new SqliteStudioDraftStore();

  statusCalls = 0;
  confirmedStatus = "delivered";
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const target = new URL(url);
    if (target.pathname.endsWith("dev_status.php")) {
      statusCalls += 1;
      return Promise.resolve(
        json({
          success: true,
          order_ref: target.searchParams.get("order_ref"),
          status: confirmedStatus,
        }),
      );
    }
    return Promise.resolve(json({ success: true }, 200));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function seedDraft(user: SessionUser): Promise<string> {
  const draft = await drafts.create(
    user,
    createDefaultBrief({
      businessName: user === userA ? "Adom Data Hub" : "Kofi Data",
      category: "data-bundles",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
    }),
  );
  return draft.id;
}

/** A saved connection, inserted directly so the secret is under our control. */
async function seedIntegration(
  draftId: string,
  ownerId: string,
  options: { webhookSecret?: string | null } = {},
): Promise<string> {
  const row = await integrations.insert({
    draftId,
    ownerId,
    provider: "techchief",
    apiKeyEnc: encryptSessionValue(KEY),
    keyPrefix: KEY.slice(0, 9),
    webhookSecretEnc:
      options.webhookSecret === null
        ? null
        : encryptSessionValue(options.webhookSecret ?? SECRET),
    status: "verified",
    walletBalance: 42.5,
    lowBalance: false,
    accountStatus: "active",
    bundles: [
      {
        id: 11,
        network: "MTN",
        sizeGb: 1,
        validityDays: 7,
        price: 8.5,
        currency: "GHS",
      },
    ],
    bundlesSyncedAt: new Date().toISOString(),
  });
  return row!.id;
}

async function seedDelivery(
  draftId: string,
  ownerId: string,
  overrides: Partial<NewOrderInput> = {},
): Promise<{ orderId: string; deliveryId: string }> {
  const order = await orders.create({
    ownerId,
    draftId,
    accessCode: `code-${Math.random().toString(36).slice(2)}`,
    status: "paid",
    currency: "GHS",
    subtotal: 10,
    deliveryFee: 0,
    total: 10,
    lines: [
      {
        itemId: "bundle-00",
        name: "MTN 1GB",
        price: 10,
        quantity: 1,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
    ],
    customerName: "Ama",
    customerPhone: "0240000002",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    ...overrides,
  });
  const input: NewBundleDeliveryInput = {
    orderId: order.id,
    ownerId,
    lineIndex: 0,
    unitIndex: 0,
    itemId: "bundle-00",
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    validity: "7 days",
    recipientPhone: "0240000001",
    provider: "techchief",
  };
  await deliveries.createMany([input]);
  const [row] = await deliveries.listForOrder(order.id);
  await deliveries.claimForDispatch(row.id, { provider: "techchief" });
  await deliveries.setProviderRef(row.id, ORDER_REF);
  return { orderId: order.id, deliveryId: row.id };
}

function webhookRequest(
  body: string,
  options: { integration?: string | null; signature?: string | null } = {},
): NextRequest {
  const integration =
    options.integration === undefined ? "integration-id" : options.integration;
  const url = `https://shop.example/api/bundle-delivery/techchief/webhook${
    integration ? `?integration=${integration}` : ""
  }`;
  const headers = new Headers({ "content-type": "application/json" });
  if (options.signature)
    headers.set("x-techchiefx-signature", options.signature);
  return new NextRequest(url, { method: "POST", headers, body });
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "bundle.status",
    order_ref: ORDER_REF,
    network: "MTN",
    size_gb: 1,
    recipient: "0240000001",
    status: "delivered",
    timestamp: "2026-09-03T10:00:00Z",
    ...overrides,
  });
}

describe("signed TechChief callbacks", () => {
  it("a valid signature marks the row delivered", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    const body = payload();

    const response = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "delivered",
      changed: true,
    });
    const row = await deliveries.getById(deliveryId);
    expect(row!.status).toBe("delivered");
    expect(row!.deliveredAt).toBeTruthy();
    // The signed path makes no external call at all, so the answer always
    // lands inside TechChief's eight seconds.
    expect(statusCalls).toBe(0);
  });

  it("a wrong signature is refused and changes nothing", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    const body = payload();

    const response = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body, "a-different-secret"),
      }),
    );

    expect(response.status).toBe(401);
    expect((await deliveries.getById(deliveryId))!.status).toBe("processing");
    expect(statusCalls).toBe(0);
  });

  it("a missing signature is refused when a secret is configured", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);

    const response = await POST(
      webhookRequest(payload(), { integration: integrationId }),
    );

    expect(response.status).toBe(401);
    expect((await deliveries.getById(deliveryId))!.status).toBe("processing");
  });

  it("a signature over a tampered body is refused", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    const signed = payload({ status: "processing" });
    // The attacker replays the good signature with a different body.
    const tampered = payload({ status: "delivered" });

    const response = await POST(
      webhookRequest(tampered, {
        integration: integrationId,
        signature: sign(signed),
      }),
    );

    expect(response.status).toBe(401);
    expect((await deliveries.getById(deliveryId))!.status).toBe("processing");
  });

  it("a failed event marks the row failed with owner wording", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    const body = payload({ status: "failed" });

    const response = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    expect(response.status).toBe(200);
    const row = await deliveries.getById(deliveryId);
    expect(row!.status).toBe("failed");
    expect(row!.lastError).toContain("failed");
  });

  it("a refunded event is treated as a failure the owner can retry", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    const body = payload({ status: "refunded" });

    await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    const row = await deliveries.getById(deliveryId);
    expect(row!.status).toBe("failed");
    expect(row!.lastError).toContain("refunded");
  });

  it("accepted and processing events change nothing", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);

    for (const status of ["accepted", "processing"]) {
      const body = payload({ status });
      const response = await POST(
        webhookRequest(body, {
          integration: integrationId,
          signature: sign(body),
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ changed: false });
    }
    expect((await deliveries.getById(deliveryId))!.status).toBe("processing");
  });

  it("I3 — a delivered row is never changed by a later failed event", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);

    const good = payload({ status: "delivered" });
    await POST(
      webhookRequest(good, {
        integration: integrationId,
        signature: sign(good),
      }),
    );
    const delivered = await deliveries.getById(deliveryId);

    const late = payload({ status: "failed" });
    const response = await POST(
      webhookRequest(late, {
        integration: integrationId,
        signature: sign(late),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "delivered",
      changed: false,
    });
    const after = await deliveries.getById(deliveryId);
    expect(after!.status).toBe("delivered");
    expect(after!.deliveredAt).toBe(delivered!.deliveredAt);
    expect(after!.lastError).toBeFalsy();
  });

  it("a duplicate delivery event is a no-op", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    const body = payload();

    const first = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );
    const second = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    await expect(first.json()).resolves.toMatchObject({ changed: true });
    await expect(second.json()).resolves.toMatchObject({ changed: false });
    expect((await deliveries.getById(deliveryId))!.status).toBe("delivered");
  });

  it("a duplicate failure event does not alert the merchant twice", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    const body = payload({ status: "failed" });

    const first = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );
    const second = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    await expect(first.json()).resolves.toMatchObject({ changed: true });
    await expect(second.json()).resolves.toMatchObject({ changed: false });
    expect((await deliveries.getById(deliveryId))!.attempts).toBe(1);
  });
});

describe("callback trust boundaries", () => {
  it("an unknown order reference is ignored with 200 and no outbound call", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    await seedDelivery(draftId, OWNER_A);
    const body = payload({ order_ref: "DEV-SOMETHING-ELSE" });

    const response = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ignored: true });
    expect(statusCalls).toBe(0);
  });

  it("a reference belonging to another shop's order is ignored", async () => {
    const draftA = await seedDraft(userA);
    const draftB = await seedDraft(userB);
    const integrationB = await seedIntegration(draftB, OWNER_B);
    const { deliveryId } = await seedDelivery(draftA, OWNER_A);
    // Shop B's connection receives a validly signed callback for shop A's row:
    // the signature is B's, the reference is A's, so nothing may change.
    const body = payload();

    const response = await POST(
      webhookRequest(body, {
        integration: integrationB,
        signature: sign(body),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ignored: true });
    expect((await deliveries.getById(deliveryId))!.status).toBe("processing");
  });

  it("an unknown integration id is answered like a matched one — no probing", async () => {
    const response = await POST(
      webhookRequest(payload(), { integration: "not-a-real-id" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ignored: true });
    expect(statusCalls).toBe(0);
  });

  it("a missing integration parameter is a 400", async () => {
    const response = await POST(
      webhookRequest(payload(), { integration: null }),
    );
    expect(response.status).toBe(400);
  });

  it("a body that is not JSON is a 400", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const body = "not json at all";

    const response = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("a body without an order reference is a 400", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const body = JSON.stringify({ status: "delivered" });

    const response = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("an oversized body is refused before it is parsed", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A);
    const body = payload({ padding: "x".repeat(30_000) });

    const response = await POST(
      webhookRequest(body, {
        integration: integrationId,
        signature: sign(body),
      }),
    );

    expect(response.status).toBe(413);
  });
});

describe("unsigned callbacks are confirmed, never believed", () => {
  it("confirms with dev_status.php before marking a row delivered", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A, {
      webhookSecret: null,
    });
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    confirmedStatus = "delivered";

    const response = await POST(
      webhookRequest(payload(), { integration: integrationId }),
    );

    expect(response.status).toBe(200);
    expect(statusCalls).toBe(1);
    expect((await deliveries.getById(deliveryId))!.status).toBe("delivered");
  });

  it("ignores a payload that TechChief does not confirm", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A, {
      webhookSecret: null,
    });
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    // The unsigned caller claims "delivered"; TechChief says it is still going.
    confirmedStatus = "processing";

    const response = await POST(
      webhookRequest(payload(), { integration: integrationId }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "processing",
      changed: false,
    });
    expect((await deliveries.getById(deliveryId))!.status).toBe("processing");
  });

  it("applies a confirmed failure the payload claimed", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A, {
      webhookSecret: null,
    });
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    confirmedStatus = "failed";

    await POST(webhookRequest(payload(), { integration: integrationId }));

    expect((await deliveries.getById(deliveryId))!.status).toBe("failed");
  });

  it("a forged unsigned callback for an unknown reference costs nothing", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A, {
      webhookSecret: null,
    });
    await seedDelivery(draftId, OWNER_A);

    const response = await POST(
      webhookRequest(payload({ order_ref: "DEV-GUESSED" }), {
        integration: integrationId,
      }),
    );

    expect(response.status).toBe(200);
    // No confirmation call: an attacker cannot spend the shop's hourly budget
    // by posting references that do not exist.
    expect(statusCalls).toBe(0);
  });

  it("still answers 200 when TechChief cannot be reached to confirm", async () => {
    const draftId = await seedDraft(userA);
    const integrationId = await seedIntegration(draftId, OWNER_A, {
      webhookSecret: null,
    });
    const { deliveryId } = await seedDelivery(draftId, OWNER_A);
    fetchMock.mockImplementation(() =>
      Promise.reject(new TypeError("fetch failed")),
    );

    const response = await POST(
      webhookRequest(payload(), { integration: integrationId }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ confirmed: false });
    expect((await deliveries.getById(deliveryId))!.status).toBe("processing");
  });
});
