/**
 * Phase 2: logo and photo uploads for Website Studio.
 *
 * Images are stored as data URLs inside the brief JSON so a single SQLite
 * record (or PostgreSQL jsonb column) holds the whole draft — no separate
 * binary table, no filesystem writes, and backup/import carries every asset
 * automatically because `buildBackup`/`importStudioDrafts` already serialize
 * the brief wholesale. The limits below balance quality and cost: a custom
 * logo may be up to 10MB (plain-English error), photos stay smaller, and the
 * total budget keeps the brief from bloating every autosave.
 */

export const MAX_LOGO_BYTES = 10 * 1024 * 1024; // 10 MB — custom logo upload (Brand Kit)
export const MAX_PHOTO_BYTES = 1024 * 1024; // 1 MB per photo
export const MAX_PHOTOS = 8;
/** Total across logo + all photos for one draft. */
export const MAX_TOTAL_ASSET_BYTES = 15 * 1024 * 1024; // 15 MB — logo 10MB + photos
export const ACCEPTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
/** Brand-kit custom logo upload accepts PNG/JPEG/WebP only (no GIF, no SVG). */
export const ACCEPTED_BRAND_LOGO_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
/** Side length used when downscaling photos server-side. */
export const PHOTO_MAX_SIDE = 1600;
/** Side length used when downscaling the logo (logos need to stay crisp at smaller sizes). */
export const LOGO_MAX_SIDE = 600;

export interface StoredImage {
  /** Data URL: "data:image/png;base64,...." Safe to drop straight into <img src>. */
  dataUrl: string;
  /** Original filename the user picked, kept for "Download original" affordances. */
  fileName: string;
  /** MIME type, always one of ACCEPTED_MIME_TYPES. */
  mime: string;
  /** Width in pixels after downscaling. */
  width: number;
  /** Height in pixels after downscaling. */
  height: number;
  /** Byte length of the base64-decoded payload. */
  size: number;
}

export interface AssetState {
  logo: StoredImage | null;
  photos: StoredImage[];
}

export const emptyAssets: AssetState = { logo: null, photos: [] };

import { BadRequestError } from "@/lib/api-errors";

export class AssetError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = "AssetError";
  }
}

/** Decode a data URL into a Buffer + MIME, returning null if it is not one. */
export function decodeDataUrl(dataUrl: string): {
  mime: string;
  bytes: Buffer;
} | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1]!.toLowerCase();
  const isBase64 = Boolean(match[2]);
  const data = match[3]!;
  if (!isBase64) {
    try {
      return { mime, bytes: Buffer.from(decodeURIComponent(data), "utf8") };
    } catch {
      return null;
    }
  }
  try {
    return { mime, bytes: Buffer.from(data, "base64") };
  } catch {
    return null;
  }
}

/** Total byte length of every image referenced from an AssetState. */
export function totalAssetBytes(assets: AssetState): number {
  let total = 0;
  if (assets.logo) total += assets.logo.size;
  for (const photo of assets.photos) total += photo.size;
  return total;
}
