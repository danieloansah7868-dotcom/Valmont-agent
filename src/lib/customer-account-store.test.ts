import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import {
  CUSTOMER_RESET_TTL_MS,
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
});
