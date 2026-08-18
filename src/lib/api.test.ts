import { describe, expect, it } from "vitest";
import {
  safeApiError,
  RateLimitError,
  PayloadTooLargeError,
  assertOwnerRateLimit,
} from "./api";
import { NotConnectedError } from "./auth";
import { resetRateLimitForTests } from "./security";

async function body(response: Response) {
  return (await response.json()) as { error: string };
}

describe("safeApiError keeps internal detail out of responses", () => {
  // Found while testing the backup import route: a database outage returned
  // the failing statement AND its bound parameter values to the browser, with
  // a 400 that blamed the user's file for a server fault.
  it("replaces a driver error with a generic 500", async () => {
    const response = safeApiError(
      new Error(
        'Failed query: insert into "users" ("id", "github_id") values ($1, $2)\n' +
          "params: 13a0bc38-7117-5bbe-8083-f2dd24d0c1e8,9001,Ama",
      ),
    );
    expect(response.status).toBe(500);
    const text = JSON.stringify(await body(response));
    expect(text).not.toMatch(/insert into/i);
    expect(text).not.toMatch(/params:/i);
    expect(text).not.toContain("13a0bc38-7117-5bbe-8083-f2dd24d0c1e8");
  });

  it("hides connection strings and network errors", async () => {
    for (const message of [
      "connect ECONNREFUSED 127.0.0.1:5432",
      "could not connect to postgres://user:hunter2@db.example:5432/app",
      "SQLITE_CANTOPEN: unable to open database file",
      "getaddrinfo ENOTFOUND db.internal",
    ]) {
      const response = safeApiError(new Error(message));
      expect(response.status, message).toBe(500);
      const text = JSON.stringify(await body(response));
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("127.0.0.1");
      expect(text).not.toMatch(/ECONNREFUSED|ENOTFOUND|SQLITE_/i);
    }
  });

  it("screens a status-carrying error that wraps driver text", async () => {
    class Wrapped extends Error {
      readonly status = 400;
    }
    const response = safeApiError(
      new Wrapped('Failed query: select * from "studio_drafts"'),
    );
    // Blaming the request would be wrong, and the schema must not leak.
    expect(response.status).toBe(500);
    expect((await body(response)).error).not.toMatch(/studio_drafts/);
  });

  it("still passes through deliberate, safe messages", async () => {
    const rate = safeApiError(new RateLimitError());
    expect(rate.status).toBe(429);
    expect((await body(rate)).error).toMatch(/rate limit/i);

    const large = safeApiError(new PayloadTooLargeError());
    expect(large.status).toBe(413);

    const auth = safeApiError(new NotConnectedError());
    expect(auth.status).toBe(401);

    const missing = safeApiError(new Error("Chat not found"));
    expect(missing.status).toBe(404);

    const csrf = safeApiError(new Error("Invalid CSRF token"));
    expect(csrf.status).toBe(403);

    const validation = safeApiError(new Error("Business name is required"));
    expect(validation.status).toBe(400);
    expect((await body(validation)).error).toBe("Business name is required");
  });

  it("rate-limits an authenticated owner independently of other owners", () => {
    resetRateLimitForTests();
    const owner = "owner-canonical-id";
    for (let index = 0; index < 5; index += 1) {
      expect(() =>
        assertOwnerRateLimit("backup-import", owner, 5),
      ).not.toThrow();
    }
    expect(() => assertOwnerRateLimit("backup-import", owner, 5)).toThrow(
      RateLimitError,
    );
    expect(() =>
      assertOwnerRateLimit("backup-import", "a-different-owner", 5),
    ).not.toThrow();
  });

  it("does not leak a stack frame", async () => {
    const response = safeApiError(
      new Error("boom at Object.handler (/app/src/lib/secret.ts:12:9)"),
    );
    expect(response.status).toBe(500);
    expect((await body(response)).error).not.toContain("/app/src");
  });
});
