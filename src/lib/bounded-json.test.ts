import { describe, expect, it } from "vitest";
import { PayloadTooLargeError } from "@/lib/api";
import {
  BACKUP_BODY_LIMIT_BYTES,
  DRAFT_BODY_LIMIT_BYTES,
  readBoundedJson,
} from "@/lib/bounded-json";

/** A request whose body arrives in pieces, like a real chunked upload. */
function chunkedRequest(
  chunks: string[],
  headers: Record<string, string> = {},
): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://example.test/api", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    // Required by undici when the body is a stream.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function jsonOfSize(bytes: number): string {
  const filler = "x".repeat(Math.max(0, bytes - 12));
  return JSON.stringify({ a: filler });
}

describe("readBoundedJson", () => {
  it("reads a normal body and parses it", async () => {
    const request = chunkedRequest([JSON.stringify({ businessName: "Adom" })]);
    await expect(
      readBoundedJson(request, DRAFT_BODY_LIMIT_BYTES),
    ).resolves.toEqual({
      businessName: "Adom",
    });
  });

  it("reassembles a body split across several chunks", async () => {
    const request = chunkedRequest(['{"a":', '"one",', '"b":"two"}']);
    await expect(
      readBoundedJson(request, DRAFT_BODY_LIMIT_BYTES),
    ).resolves.toEqual({
      a: "one",
      b: "two",
    });
  });

  it("rejects a body over the limit", async () => {
    const request = chunkedRequest([jsonOfSize(2000)]);
    await expect(readBoundedJson(request, 1000)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("rejects an oversized body even with NO Content-Length header", async () => {
    // A streamed body carries no Content-Length at all.
    const request = chunkedRequest([jsonOfSize(5000)]);
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readBoundedJson(request, 1000)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("rejects an oversized body that LIES with a small Content-Length", async () => {
    const request = chunkedRequest([jsonOfSize(5000)], {
      "content-length": "10",
    });
    await expect(readBoundedJson(request, 1000)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("rejects an oversized body delivered in many small chunks", async () => {
    // No single chunk exceeds the limit; only the running total does.
    const chunks = [
      '{"a":"',
      ...Array.from({ length: 50 }, () => "y".repeat(100)),
      '"}',
    ];
    await expect(
      readBoundedJson(chunkedRequest(chunks), 1000),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("stops reading instead of draining the whole oversized stream", async () => {
    const encoder = new TextEncoder();
    let produced = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        if (produced > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode("z".repeat(500)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://example.test/api", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedJson(request, 1000)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    expect(cancelled).toBe(true);
    // Far fewer than the 1000 chunks the stream was willing to produce.
    expect(produced).toBeLessThan(10);
  });

  it("accepts a body exactly on the limit and rejects one byte more", async () => {
    const exact = "a".repeat(998);
    const payload = `"${exact}"`; // 1000 bytes
    expect(Buffer.byteLength(payload, "utf8")).toBe(1000);
    await expect(
      readBoundedJson(chunkedRequest([payload]), 1000),
    ).resolves.toBe(exact);

    const oneMore = `"${"a".repeat(999)}"`;
    await expect(
      readBoundedJson(chunkedRequest([oneMore]), 1000),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("counts real bytes, not characters, for multi-byte text", async () => {
    // Each of these characters is 3 bytes in UTF-8.
    const payload = JSON.stringify({ a: "₵".repeat(200) });
    expect(payload.length).toBeLessThan(Buffer.byteLength(payload, "utf8"));
    await expect(
      readBoundedJson(chunkedRequest([payload]), 300),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("returns null for an empty body", async () => {
    const request = new Request("https://example.test/api", { method: "POST" });
    await expect(
      readBoundedJson(request, DRAFT_BODY_LIMIT_BYTES),
    ).resolves.toBeNull();
  });

  it("reports invalid JSON without echoing the body back", async () => {
    const secret = "0244000111 private client number";
    const error = await readBoundedJson(
      chunkedRequest([`{not json ${secret}`]),
      DRAFT_BODY_LIMIT_BYTES,
    ).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Request body is not valid JSON");
    expect((error as Error).message).not.toContain(secret);
  });

  it("uses 1 MB for draft edits and 25 MB for backup imports", () => {
    expect(DRAFT_BODY_LIMIT_BYTES).toBe(1_000_000);
    expect(BACKUP_BODY_LIMIT_BYTES).toBe(25_000_000);
    expect(BACKUP_BODY_LIMIT_BYTES).toBeGreaterThan(DRAFT_BODY_LIMIT_BYTES);
  });

  it("allows a large-but-legal backup that a draft edit would refuse", async () => {
    const payload = jsonOfSize(1_500_000);
    await expect(
      readBoundedJson(chunkedRequest([payload]), DRAFT_BODY_LIMIT_BYTES),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(
      readBoundedJson(chunkedRequest([payload]), BACKUP_BODY_LIMIT_BYTES),
    ).resolves.toMatchObject({ a: expect.any(String) });
  });
});
