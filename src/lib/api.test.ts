import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  safeApiError,
  RateLimitError,
  PayloadTooLargeError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  assertOwnerRateLimit,
} from "./api";
import { NotConnectedError } from "./auth";
import { resetRateLimitForTests } from "./security";
import {
  ChatNotFoundError,
  TaskNotFoundError,
  CustomerEmailDeliveryError,
  CustomerEmailConfigurationError,
} from "./api-errors";

async function body(response: Response) {
  return (await response.json()) as { error: string };
}

describe("safeApiError keeps internal detail out of responses", () => {
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
    // Arbitrary object with status should NOT control response — must be ApiError instance
    const fake = {
      message: 'Failed query: select * from "studio_drafts"',
      status: 400,
    };
    const response = safeApiError(fake);
    expect(response.status).toBe(500);
    expect((await body(response)).error).not.toMatch(/studio_drafts/);
  });

  it("arbitrary message-bearing errors remain opaque 500", async () => {
    const arbitrary = new Error("Task not found");
    const response = safeApiError(arbitrary);
    expect(response.status).toBe(500);
    expect((await body(response)).error).toBe(
      "Something went wrong handling that request. Please try again.",
    );
  });

  it("does not trust plain object with status property", async () => {
    const obj = { status: 404, message: "Not found" };
    const response = safeApiError(obj);
    expect(response.status).toBe(500);
  });

  it("still passes through deliberate typed ApiError instances", async () => {
    const rate = safeApiError(new RateLimitError());
    expect(rate.status).toBe(429);
    expect((await body(rate)).error).toMatch(/rate limit/i);

    const large = safeApiError(new PayloadTooLargeError());
    expect(large.status).toBe(413);

    const auth = safeApiError(new NotConnectedError());
    expect(auth.status).toBe(401);

    const chatMissing = safeApiError(new ChatNotFoundError());
    expect(chatMissing.status).toBe(404);

    const taskMissing = safeApiError(new TaskNotFoundError());
    expect(taskMissing.status).toBe(404);

    const forbidden = safeApiError(new ForbiddenError("Invalid CSRF token"));
    expect(forbidden.status).toBe(403);

    const bad = safeApiError(new BadRequestError("Invalid request"));
    expect(bad.status).toBe(400);

    const notFound = safeApiError(new NotFoundError("Custom not found"));
    expect(notFound.status).toBe(404);

    const emailDelivery = safeApiError(new CustomerEmailDeliveryError());
    expect(emailDelivery.status).toBe(502);

    const emailConfig = safeApiError(new CustomerEmailConfigurationError());
    expect(emailConfig.status).toBe(503);
  });

  it("returns generic 400 for Zod validation failures", async () => {
    const schema = z.object({ name: z.string() });
    try {
      schema.parse({ name: 123 });
    } catch (error) {
      const response = safeApiError(error);
      expect(response.status).toBe(400);
      const text = (await body(response)).error;
      expect(text).toBe("Invalid request");
    }
  });

  it("returns generic 400 for JSON syntax failures", async () => {
    const response = safeApiError(new SyntaxError("Unexpected token"));
    expect(response.status).toBe(400);
    expect((await body(response)).error).toBe("Invalid request");

    const response2 = safeApiError(new Error("Request body is not valid JSON"));
    expect(response2.status).toBe(400);
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

  it("does not expose transport/network details", async () => {
    const response = safeApiError(new Error("ETIMEDOUT connecting to db"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await body(response))).not.toMatch(/ETIMEDOUT/);
  });

  it("does not expose stack/path details", async () => {
    const response = safeApiError(
      new Error("Error at /home/user/app/src/secret.ts:123:45"),
    );
    expect(response.status).toBe(500);
    expect((await body(response)).error).not.toContain("/home/user");
  });
});
