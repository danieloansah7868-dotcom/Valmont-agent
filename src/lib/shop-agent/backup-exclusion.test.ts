import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { buildBackup } from "@/lib/studio/backup";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { SqliteShopAgentStore } from "./store";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
let dir: string;
let chat: SqliteChatStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-agent-backup-"));
  chat = new SqliteChatStore(
    path.join(dir, "chat.sqlite"),
    path.join(dir, "chat.json"),
  );
  setSqliteChatStoreForTests(chat);
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("agent backup exclusion", () => {
  it("does not export agent credentials, sessions, ledger entries, or settings", async () => {
    const drafts = new SqliteStudioDraftStore();
    const shop = await drafts.create(agency, {
      ...createDefaultBrief(),
      category: "data-bundles",
      businessName: "Data GH",
    });
    const agents = new SqliteShopAgentStore();
    const agent = await agents.createInvite({
      draftId: shop.id,
      email: "agent@example.com",
      name: "Agent",
      invitedBy: "owner",
    });
    await agents.setDiscountPercent(shop.id, 8);
    await agents.credit({
      agentId: agent.id,
      amountMinor: 5000,
      createdBy: "owner",
    });
    const backup = await buildBackup(agency);
    const text = JSON.stringify(backup);
    expect(text).toContain("Data GH");
    expect(text).not.toContain("studio_shop_agents");
    expect(text).not.toContain("agent@example.com");
    expect(text).not.toContain("studio_shop_wallet_entries");
  });
});
