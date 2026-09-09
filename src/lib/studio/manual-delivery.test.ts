/**
 * Stage 6c — the shop's manual delivery marks, against the real SQLite
 * store.
 *
 * What these tests prove is the shape of the two atomic UPDATEs in
 * `manual-delivery.ts`: every ALLOWED transition moves the row exactly once
 * and touches only the fields it may touch (provider, provider reference
 * and attempts never change — nothing was sent by a provider); every
 * REFUSED transition answers 409 with the exact plain sentence the shop
 * browser shows; and two people marking at once produce exactly one winner,
 * because the guards live inside the WHERE clause, exactly like
 * `claimForDispatch`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SqliteBundleDeliveriesStore,
  type BundleDeliveryRecord,
  type NewBundleDeliveryInput,
} from "./bundle-delivery";
import {
  DEFAULT_MARK_FAILED_NOTE,
  MARK_ALREADY_DELIVERED_MESSAGE,
  MARK_ALREADY_FAILED_MESSAGE,
  MARK_PENDING_AUTOMATIC_MESSAGE,
  MARK_PROCESSING_MESSAGE,
  markDeliveryDeliveredByShop,
  markDeliveryFailedByShop,
} from "./manual-delivery";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";

const dirs: string[] = [];
let deliveries: SqliteBundleDeliveriesStore;
let sequence = 0;

const ORDER_ID = "order-manual-1";
const OWNER_ID = "owner-1";
const RECIPIENT = "0240000001";

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-manual-mark-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  delete process.env.DATABASE_URL;
  deliveries = new SqliteBundleDeliveriesStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A fresh row in the state asked for, through the real store's own moves. */
async function rowIn(
  state:
    | "pending-manual"
    | "pending-automatic"
    | "processing"
    | "failed"
    | "delivered",
): Promise<BundleDeliveryRecord> {
  sequence += 1;
  const input: NewBundleDeliveryInput = {
    orderId: ORDER_ID,
    ownerId: OWNER_ID,
    lineIndex: 0,
    unitIndex: sequence - 1,
    itemId: "bundle-00",
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    recipientPhone: RECIPIENT,
    provider:
      state === "pending-automatic" || state === "processing"
        ? "simulator"
        : "manual",
  };
  const [row] = await deliveries.createMany([input]);
  if (!row) throw new Error("row should have been created");
  if (state === "processing") {
    const claimed = await deliveries.claimForDispatch(row.id, {
      provider: "simulator",
    });
    if (!claimed) throw new Error("row should have been claimed");
    await deliveries.setProviderRef(row.id, "sim-ref-1");
  } else if (state === "failed") {
    // A failed AUTOMATIC row carrying its attempt and provider reference:
    // the interesting case for failed → delivered by hand.
    await deliveries.claimForDispatch(row.id, { provider: "simulator" });
    await deliveries.setProviderRef(row.id, "sim-ref-1");
    const failed = await deliveries.markFailed(row.id, {
      error: "provider said no",
    });
    if (!failed) throw new Error("row should have been failed");
  } else if (state === "delivered") {
    const delivered = await deliveries.markDelivered(row.id);
    if (!delivered) throw new Error("row should have been delivered");
  }
  const fresh = await deliveries.getById(row.id);
  if (!fresh) throw new Error("row should exist");
  return fresh;
}

describe("allowed transitions", () => {
  it("pending manual → delivered: delivered_at set, last_error cleared, provider/ref/attempts untouched", async () => {
    const row = await rowIn("pending-manual");

    const updated = await markDeliveryDeliveredByShop(row.id);

    expect(updated.status).toBe("delivered");
    expect(updated.deliveredAt).toBeTruthy();
    expect(updated.lastError).toBeUndefined();
    expect(updated.provider).toBe("manual");
    expect(updated.providerRef).toBeUndefined();
    expect(updated.attempts).toBe(0);
  });

  it("pending manual → failed with a note: the trimmed note becomes last_error", async () => {
    const row = await rowIn("pending-manual");

    const updated = await markDeliveryFailedByShop(
      row.id,
      "  no float at the kiosk  ",
    );

    expect(updated.status).toBe("failed");
    expect(updated.lastError).toBe("no float at the kiosk");
    expect(updated.provider).toBe("manual");
    expect(updated.attempts).toBe(0);
    expect(updated.deliveredAt).toBeUndefined();
  });

  it("pending manual → failed without a note: the plain default sentence", async () => {
    const row = await rowIn("pending-manual");

    const updated = await markDeliveryFailedByShop(row.id, "   ");

    expect(updated.status).toBe("failed");
    expect(updated.lastError).toBe(DEFAULT_MARK_FAILED_NOTE);
    expect(DEFAULT_MARK_FAILED_NOTE).toBe("Marked as not sent by the shop.");
  });

  it("failed (any provider) → delivered: provider, reference and attempts survive", async () => {
    const row = await rowIn("failed");
    expect(row.provider).toBe("simulator");

    const updated = await markDeliveryDeliveredByShop(row.id);

    expect(updated.status).toBe("delivered");
    expect(updated.deliveredAt).toBeTruthy();
    expect(updated.lastError).toBeUndefined();
    // The shop confirms an out-of-band settlement; nothing about the
    // provider's own attempt history is rewritten.
    expect(updated.provider).toBe("simulator");
    expect(updated.providerRef).toBe("sim-ref-1");
    expect(updated.attempts).toBe(1);
  });

  it("delivered is terminal: the guard never matches a delivered row again (I3)", async () => {
    const row = await rowIn("pending-manual");
    const delivered = await markDeliveryDeliveredByShop(row.id);
    expect(delivered.status).toBe("delivered");

    await expect(markDeliveryDeliveredByShop(row.id)).rejects.toMatchObject({
      status: 409,
      message: MARK_ALREADY_DELIVERED_MESSAGE,
    });
    // And it can never be dragged to failed either.
    await expect(
      markDeliveryFailedByShop(row.id, "late regret"),
    ).rejects.toMatchObject({
      status: 409,
      message: MARK_ALREADY_DELIVERED_MESSAGE,
    });
    const fresh = await deliveries.getById(row.id);
    expect(fresh?.status).toBe("delivered");
  });
});

describe("refused transitions — the exact 409 sentences", () => {
  it("a processing row answers the Check status sentence", async () => {
    const row = await rowIn("processing");
    await expect(markDeliveryDeliveredByShop(row.id)).rejects.toMatchObject({
      status: 409,
      message: MARK_PROCESSING_MESSAGE,
    });
    await expect(markDeliveryFailedByShop(row.id, "")).rejects.toMatchObject({
      status: 409,
      message: MARK_PROCESSING_MESSAGE,
    });
    expect(MARK_PROCESSING_MESSAGE).toBe(
      "This top-up is being sent automatically - use Check status.",
    );
  });

  it("a pending automatic row answers the queued sentence", async () => {
    const row = await rowIn("pending-automatic");
    await expect(markDeliveryDeliveredByShop(row.id)).rejects.toMatchObject({
      status: 409,
      message: MARK_PENDING_AUTOMATIC_MESSAGE,
    });
    await expect(markDeliveryFailedByShop(row.id, "")).rejects.toMatchObject({
      status: 409,
      message: MARK_PENDING_AUTOMATIC_MESSAGE,
    });
    expect(MARK_PENDING_AUTOMATIC_MESSAGE).toBe(
      "This top-up is queued for automatic sending - use Check status.",
    );
    const fresh = await deliveries.getById(row.id);
    expect(fresh?.status).toBe("pending");
  });

  it("a failed row asked to be marked failed answers the already-failed sentence", async () => {
    const row = await rowIn("failed");
    await expect(
      markDeliveryFailedByShop(row.id, "again"),
    ).rejects.toMatchObject({
      status: 409,
      message: MARK_ALREADY_FAILED_MESSAGE,
    });
    expect(MARK_ALREADY_FAILED_MESSAGE).toBe(
      "This top-up is already marked as failed.",
    );
  });

  it("an unknown id is a 404, not a 409", async () => {
    await expect(
      markDeliveryDeliveredByShop("no-such-row"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      markDeliveryFailedByShop("no-such-row", ""),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("one winner under concurrency", () => {
  it("two parallel marks on the same row give exactly one success", async () => {
    const row = await rowIn("pending-manual");

    const outcomes = await Promise.allSettled([
      markDeliveryDeliveredByShop(row.id),
      markDeliveryDeliveredByShop(row.id),
    ]);

    const wins = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    ).length;
    const conflicts = outcomes.filter(
      (outcome) =>
        outcome.status === "rejected" &&
        outcome.reason instanceof Error &&
        outcome.reason.message === MARK_ALREADY_DELIVERED_MESSAGE,
    ).length;
    expect(wins).toBe(1);
    expect(conflicts).toBe(1);

    const fresh = await deliveries.getById(row.id);
    expect(fresh?.status).toBe("delivered");
    expect(fresh?.attempts).toBe(0);
  });

  it("a delivered mark and a failed mark racing give exactly one winner", async () => {
    const row = await rowIn("pending-manual");

    const outcomes = await Promise.allSettled([
      markDeliveryDeliveredByShop(row.id),
      markDeliveryFailedByShop(row.id, "other hand"),
    ]);

    const wins = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    ).length;
    expect(wins).toBe(1);
    const fresh = await deliveries.getById(row.id);
    // Whichever write landed, the row is in exactly one of the two states.
    expect(["delivered", "failed"]).toContain(fresh?.status);
  });
});
