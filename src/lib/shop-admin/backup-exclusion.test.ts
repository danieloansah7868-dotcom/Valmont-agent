/**
 * Stage 6b — shop logins stay out of the backup file.
 *
 * A backup is a file people keep and pass around. The three shop-admin tables
 * hold password hashes, hashed session cookies and hashed one-time links —
 * none of which belongs in it. `buildBackup` has no generic table dump, so
 * the tables are excluded by construction; this test is the proof that stays
 * true, and that a file which *does* carry a `shopAdmins` section (crafted or
 * from some future build) is imported with that section ignored rather than
 * written.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { setIdeaStoreForTests } from "@/lib/idea-store";
import type { SessionUser } from "@/lib/auth";
import { hashCustomerToken } from "@/lib/customer-password";
import { buildBackup, importBackup, parseBackup } from "@/lib/studio/backup";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import {
  resetShopAdminPurgeClockForTests,
  SqliteShopAdminStore,
} from "./store";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const PASSWORD = "correct horse battery";

const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;
let store: SqliteShopAdminStore;

function freshDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-shop-backup-"));
  dirs.push(dir);
  chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(chatStore);
  setIdeaStoreForTests(null);
  drafts = new SqliteStudioDraftStore();
  store = new SqliteShopAdminStore();
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  resetShopAdminPurgeClockForTests();
  freshDatabase();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function countRows(table: string): number {
  const row = chatStore.connection
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number | bigint };
  return Number(row.n);
}

describe("shop logins and a backup", () => {
  it("are not exported, while the website they belong to still is", async () => {
    const shop = await drafts.create(agency, {
      ...createDefaultBrief(),
      category: "data-bundles",
      businessName: "Data GH",
    });
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "shop-owner-6b@example.net",
      name: "Kofi Mensah",
      invitedBy: "agency",
    });
    const owner = await store.acceptInvite(
      invite.token,
      "Kofi Mensah",
      PASSWORD,
    );
    const session = await store.createSession(owner!.id);
    const reset = await store.createResetToken(owner!.id);
    const passwordHash = (
      chatStore.connection
        .prepare("SELECT password_hash FROM studio_shop_admins WHERE id = ?")
        .get(owner!.id) as { password_hash: string }
    ).password_hash;

    const backup = await buildBackup(agency);
    const serialised = JSON.stringify(backup);

    // The draft really is in the file — the absences below are exclusion.
    expect(serialised).toContain("Data GH");
    expect(backup.studio.drafts.some((entry) => entry.id === shop.id)).toBe(
      true,
    );

    expect(serialised).not.toContain("studio_shop_admins");
    expect(serialised).not.toContain("shopAdmins");
    expect(serialised).not.toContain("shop-owner-6b@example.net");
    expect(serialised).not.toContain("Kofi Mensah");
    expect(serialised).not.toContain(passwordHash);
    expect(serialised).not.toContain(session.token);
    expect(serialised).not.toContain(hashCustomerToken(session.token));
    expect(serialised).not.toContain(reset.token);
    expect(serialised).not.toContain(hashCustomerToken(reset.token));
    expect(serialised).not.toContain(owner!.id);
  });

  it("a file carrying a shopAdmins section is imported with that section ignored", async () => {
    const shop = await drafts.create(agency, {
      ...createDefaultBrief(),
      category: "data-bundles",
      businessName: "Data GH",
    });
    const backup = await buildBackup(agency);

    // Restore into a fresh database, with an extra section a future build or
    // a hand-edited file might carry.
    freshDatabase();
    const crafted = {
      ...JSON.parse(JSON.stringify(backup)),
      shopAdmins: {
        admins: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            draft_id: shop.id,
            email: "smuggled@example.com",
            name: "Smuggled",
            role: "owner",
            permissions: "[]",
            password_hash: "scrypt$N=32768,r=8,p=1$c2FsdA$aGFzaA",
            status: "active",
          },
        ],
        sessions: [
          {
            token_hash: hashCustomerToken("smuggled-session"),
            admin_id: "11111111-1111-4111-8111-111111111111",
            draft_id: shop.id,
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        ],
        tokens: [],
      },
    };

    const summary = await importBackup(agency, parseBackup(crafted));
    expect(summary.studioDrafts).toBe(1);
    expect(await drafts.list(agency)).toHaveLength(1);

    expect(await store.listForDraft(shop.id)).toEqual([]);
    expect(countRows("studio_shop_admins")).toBe(0);
    expect(countRows("studio_shop_admin_sessions")).toBe(0);
    expect(countRows("studio_shop_admin_tokens")).toBe(0);
    expect(await store.getSession("smuggled-session")).toBeNull();
  });
});
