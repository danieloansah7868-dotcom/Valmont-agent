import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import {
  CUSTOMER_RESET_TTL_MS,
  CUSTOMER_SESSION_TTL_MS,
  resetCustomerPurgeClockForTests,
  SqliteCustomerAccountStore,
} from "@/lib/customer-account-store";

const directories: string[] = [];
let store: SqliteCustomerAccountStore;

beforeEach(() => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "valmont-customer-"));
  directories.push(directory);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(directory, "chat-store.sqlite"),
      path.join(directory, "chat-store.json"),
    ),
  );
  store = new SqliteCustomerAccountStore();
  resetCustomerPurgeClockForTests();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteCustomerAccountStore", () => {
  it("hashes passwords and keeps sessions opaque", async () => {
    const account = await store.createAccount({
      name: "Ama Mensah",
      email: "AMA@example.com ",
      password: "correct horse battery staple",
    });

    expect(account.email).toBe("ama@example.com");
    expect(
      await store.verifyPassword(
        "ama@example.com",
        "correct horse battery staple",
      ),
    ).not.toBeNull();
    expect(
      await store.verifyPassword("ama@example.com", "wrong password"),
    ).toBeNull();

    const session = await store.createSession(account.id);
    expect(session.token).not.toContain(account.id);
    expect((await store.getSession(session.token))?.account.id).toBe(
      account.id,
    );
    expect(await store.getSession("not-a-real-session")).toBeNull();

    await store.revokeSession(session.token);
    expect(await store.getSession(session.token)).toBeNull();
  });

  it("verifies and consumes one-time tokens only once", async () => {
    const account = await store.createAccount({
      name: "Kojo Mensah",
      email: "kojo@example.com",
      password: "a sufficiently long password",
    });
    const token = await store.createToken(
      account.id,
      "reset_password",
      CUSTOMER_RESET_TTL_MS,
      "guest-order-access-code",
    );

    const replacement = await store.createToken(
      account.id,
      "reset_password",
      CUSTOMER_RESET_TTL_MS,
    );
    expect(await store.consumeToken(token, "reset_password")).toBeNull();
    expect(await store.consumeToken(replacement, "verify_email")).toBeNull();
    expect(await store.consumeToken(replacement, "reset_password")).toEqual({
      accountId: account.id,
      context: "guest-order-access-code",
    });
    expect(await store.consumeToken(replacement, "reset_password")).toBeNull();
  });

  it("purges expired sessions and spent or expired tokens, keeping live ones", async () => {
    const account = await store.createAccount({
      name: "Efua Mensah",
      email: "efua@example.com",
      password: "a sufficiently long password",
    });
    const live = await store.createSession(account.id);
    const stale = await store.createSession(account.id);
    const spent = await store.createToken(
      account.id,
      "verify_email",
      CUSTOMER_RESET_TTL_MS,
    );
    await store.consumeToken(spent, "verify_email");
    const pendingReset = await store.createToken(
      account.id,
      "reset_password",
      CUSTOMER_RESET_TTL_MS,
    );

    // Age one session past its expiry without touching the other. Selected by token hash: both
    // sessions are created within the same millisecond, so "newest by created_at" is a coin toss.
    const { hashCustomerToken } = await import("@/lib/customer-password");
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync })
      .db;
    db.prepare(
      "UPDATE customer_sessions SET expires_at = ? WHERE token_hash = ?",
    ).run(
      new Date(Date.now() - 1000).toISOString(),
      hashCustomerToken(stale.token),
    );

    const purged = await store.purgeExpired();

    expect(purged).toEqual({ sessions: 1, tokens: 1 });
    expect(await store.getSession(live.token)).not.toBeNull();
    expect(await store.getSession(stale.token)).toBeNull();
    expect(await store.consumeToken(pendingReset, "reset_password")).toEqual({
      accountId: account.id,
      context: undefined,
    });
    expect(CUSTOMER_SESSION_TTL_MS).toBeGreaterThan(0);
  });

  it("runs the purge opportunistically from session creation, at most hourly", async () => {
    const account = await store.createAccount({
      name: "Yaw Mensah",
      email: "yaw@example.com",
      password: "a sufficiently long password",
    });
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync })
      .db;
    db.prepare(
      `INSERT INTO customer_sessions(id, account_id, token_hash, expires_at, created_at)
       VALUES ('old-session', ?, 'old-hash', ?, ?)`,
    ).run(
      account.id,
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() - 120_000).toISOString(),
    );

    await store.createSession(account.id);
    const remaining = db
      .prepare(
        "SELECT COUNT(*) AS n FROM customer_sessions WHERE id = 'old-session'",
      )
      .get() as { n: number };
    expect(Number(remaining.n)).toBe(0);
  });
});
