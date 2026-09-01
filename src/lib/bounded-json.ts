import { BadRequestError, PayloadTooLargeError } from "@/lib/api-errors";

/** Body size ceilings. Draft edits are small; a complete backup is not. */
export const DRAFT_BODY_LIMIT_BYTES = 1_000_000; // 1 MB
export const BACKUP_BODY_LIMIT_BYTES = 25_000_000; // 25 MB

/**
 * Reads a JSON request body while counting the bytes that actually arrive.
 *
 * The `Content-Length` header is never trusted: it can be missing, wrong, or
 * absent entirely on a chunked upload. Instead the stream is read chunk by
 * chunk, the running total is compared against the limit, and reading stops the
 * moment the limit is passed. Parsing only happens after the whole body has
 * been accepted, so an oversized body is never handed to `JSON.parse`.
 */
export async function readBoundedJson(
  request: Request,
  limitBytes: number,
): Promise<unknown> {
  const text = await readBoundedText(request, limitBytes);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Never echo the body back — it may hold private business details.
    throw new BadRequestError("Invalid request");
  }
}

async function readBoundedText(
  request: Request,
  limitBytes: number,
): Promise<string> {
  const reader = request.body?.getReader();

  if (!reader) {
    // No stream available (some test doubles and empty bodies). Still measured.
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > limitBytes) {
      throw new PayloadTooLargeError();
    }
    return text;
  }

  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        // Stop pulling immediately rather than buffering the rest.
        await reader.cancel().catch(() => {});
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (total === 0) return "";
  return Buffer.concat(chunks).toString("utf8");
}
