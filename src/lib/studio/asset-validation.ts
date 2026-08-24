/**
 * Server-side validation for image uploads.
 *
 * The client resizes images in-browser before upload, but the server still
 * re-checks MIME type, magic bytes and size limits so a crafted request
 * cannot store anything outside the policy. Resizing is done on the client
 * to avoid adding a native image dependency (sharp/canvas) which breaks on
 * some Windows setups; the server's job here is "reject bad stuff".
 */
import {
  ACCEPTED_MIME_TYPES,
  MAX_LOGO_BYTES,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  MAX_TOTAL_ASSET_BYTES,
  type AssetState,
  type StoredImage,
} from "./assets";

/** The first bytes (magic numbers) for each accepted MIME type. */
const MAGIC: Readonly<Record<string, ReadonlyArray<ReadonlyArray<number>>>> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  "image/webp": [
    // "RIFF" .... "WEBP"
    [0x52, 0x49, 0x46, 0x46],
  ],
};

function startsWithMagic(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function matchesMagic(bytes: Buffer, mime: string): boolean {
  const options = MAGIC[mime];
  if (!options) return false;
  if (mime === "image/webp") {
    // RIFF....WEBP — bytes 0-3 must be "RIFF" and bytes 8-11 must be "WEBP".
    if (!startsWithMagic(bytes, options[0]!)) return false;
    if (bytes.length < 12) return false;
    return (
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return options.some((sig) => startsWithMagic(bytes, sig));
}

export class UploadRejected extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "UploadRejected";
  }
}

/**
 * Parse a client-submitted logo/photo candidate, validate it, and return a
 * StoredImage ready to attach to the brief. The client supplies the metadata
 * (width/height/fileName/mime) after its own resize; we trust nothing except
 * the bytes.
 */
export function validateUploadedImage(input: {
  kind: "logo" | "photo";
  dataUrl: unknown;
  fileName: unknown;
  mime: unknown;
  width: unknown;
  height: unknown;
}): StoredImage {
  if (typeof input.dataUrl !== "string" || !input.dataUrl.startsWith("data:")) {
    throw new UploadRejected("No image data received.");
  }
  if (typeof input.fileName !== "string" || !input.fileName.trim()) {
    throw new UploadRejected("Missing file name.");
  }
  if (typeof input.mime !== "string" || !ACCEPTED_MIME_TYPES.has(input.mime)) {
    throw new UploadRejected(
      "Unsupported image type. Use PNG, JPEG, WebP or GIF.",
    );
  }
  const width = typeof input.width === "number" ? Math.round(input.width) : 0;
  const height =
    typeof input.height === "number" ? Math.round(input.height) : 0;
  if (width < 1 || height < 1 || width > 4000 || height > 4000) {
    throw new UploadRejected("Image dimensions are invalid.");
  }

  // Parse the data URL back to bytes.
  const semi = input.dataUrl.indexOf(";");
  const comma = input.dataUrl.indexOf(",");
  if (semi < 0 || comma < 0 || comma <= semi) {
    throw new UploadRejected("Image data is malformed.");
  }
  const declaredMime = input.dataUrl.slice(5, semi).toLowerCase();
  const encoding = input.dataUrl.slice(semi + 1, comma);
  if (declaredMime !== input.mime) {
    throw new UploadRejected("Image type does not match what was declared.");
  }
  if (encoding !== "base64") {
    throw new UploadRejected("Image must be base64 encoded.");
  }
  const b64 = input.dataUrl.slice(comma + 1);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    throw new UploadRejected("Image data is not valid base64.");
  }
  const maxBytes = input.kind === "logo" ? MAX_LOGO_BYTES : MAX_PHOTO_BYTES;
  if (bytes.length === 0) throw new UploadRejected("Image file is empty.");
  if (bytes.length > maxBytes) {
    throw new UploadRejected(
      input.kind === "logo"
        ? `Logo is too large (max ${Math.round(MAX_LOGO_BYTES / 1024)} KB).`
        : `Photo is too large (max ${Math.round(MAX_PHOTO_BYTES / 1024)} KB).`,
    );
  }
  if (!matchesMagic(bytes, input.mime)) {
    throw new UploadRejected("File contents do not match the image type.");
  }

  return {
    dataUrl: input.dataUrl,
    fileName: input.fileName.trim().slice(0, 200),
    mime: input.mime,
    width,
    height,
    size: bytes.length,
  };
}

/** Enforce per-draft totals before attaching a new image. */
export function checkAssetBudget(
  current: AssetState,
  adding: { kind: "logo" | "photo"; size: number },
): void {
  let projected = 0;
  // If replacing the logo, the old one is dropped; if removing, count the rest.
  if (adding.kind === "logo") {
    projected = current.photos.reduce((a, p) => a + p.size, 0) + adding.size;
  } else {
    projected =
      (current.logo ? current.logo.size : 0) +
      current.photos.reduce((a, p) => a + p.size, 0) +
      adding.size;
  }
  if (projected > MAX_TOTAL_ASSET_BYTES) {
    throw new UploadRejected(
      `Total images for this draft would exceed ${Math.round(MAX_TOTAL_ASSET_BYTES / 1024 / 1024)} MB. Remove an existing image first.`,
    );
  }
  if (adding.kind === "photo" && current.photos.length >= MAX_PHOTOS) {
    throw new UploadRejected(
      `You can upload up to ${MAX_PHOTOS} photos per draft.`,
    );
  }
}
