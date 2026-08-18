/**
 * These cover the fix for conflict detection: a 409 must be recognised from the
 * HTTP status, never by matching words in the server's message. Rewording a
 * message must not silently disable the conflict-recovery UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiDelete, apiMutation, apiPatch } from "./client-api";

function mockFetch(
  status: number,
  body: unknown,
  { json = true }: { json?: boolean } = {},
) {
  const fn = vi.fn(async (input: string, init: RequestInit) => ({
    input,
    init,
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (!json) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Narrows a rejection to ApiError so assertions stay type-safe. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the request to reject, but it resolved");
}

beforeEach(() => {
  // Node environment: stub only the one browser API this module touches,
  // rather than pulling in a DOM implementation as a new dependency.
  vi.stubGlobal("document", { cookie: "valmont_csrf=token-abc" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiError carries the status", () => {
  it("is a real Error, so existing `catch (e) { e.message }` callers still work", async () => {
    mockFetch(400, { error: "Business name is required" });
    const error = await rejection(apiMutation("/api/studio/drafts", {}));
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("Business name is required");
    expect(error.status).toBe(400);
  });

  it("exposes 409 as data, whatever the wording of the message", async () => {
    for (const message of [
      "This draft changed somewhere else",
      "Conflict",
      "Vervang deur iemand anders", // a translated message must still work
      "",
    ]) {
      mockFetch(409, { error: message });
      const error = await rejection(apiPatch("/api/studio/drafts/x", {}));
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(409);
    }
  });

  it("does not mistake a 400 whose text mentions a conflict for a real 409", async () => {
    mockFetch(400, { error: "Opening hours conflict with delivery hours" });
    const error = await rejection(apiPatch("/api/studio/drafts/x", {}));
    expect(error.status).toBe(400);
    expect(error.status).not.toBe(409);
  });

  it("still reports the status when the error body is not JSON", async () => {
    mockFetch(502, null, { json: false });
    const error = await rejection(apiPatch("/api/studio/drafts/x", {}));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("Request failed");
  });
});

describe("successful requests", () => {
  it("returns the parsed body", async () => {
    mockFetch(200, { id: "draft-1" });
    await expect(apiMutation("/api/studio/drafts", { a: 1 })).resolves.toEqual({
      id: "draft-1",
    });
  });

  it("treats 204 as success without parsing a body", async () => {
    const fetchMock = mockFetch(204, null, { json: false });
    await expect(apiDelete("/api/studio/drafts/x")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // Regression cover for an independent-review finding: a 2xx whose body was
  // not JSON used to resolve as `undefined`, letting callers show success for a
  // write that may never have happened.
  it("rejects a 200 whose body is not JSON instead of returning undefined", async () => {
    mockFetch(200, null, { json: false });
    const error = await rejection(apiMutation("/api/studio/drafts", {}));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(200);
    expect(error.message).toMatch(/could not read/i);
  });

  it("rejects an empty 201 body rather than treating it as success", async () => {
    mockFetch(201, null, { json: false });
    const error = await rejection(apiMutation("/api/studio/drafts", {}));
    expect(error).toBeInstanceOf(ApiError);
  });

  it("sends the CSRF header on every mutation", async () => {
    const fetchMock = mockFetch(200, {});
    await apiMutation("/api/studio/drafts", {});
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-valmont-csrf"]).toBe("token-abc");
  });
});
