"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { csrfToken } from "@/lib/client-api";
import type { AssetState, StoredImage } from "@/lib/studio/assets";
import {
  ACCEPTED_MIME_TYPES,
  MAX_LOGO_BYTES,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
} from "@/lib/studio/assets";
import { dataUrlByteLength, resizeImage } from "./resize-image";

/**
 * Client-side image upload. Files picked here are drawn onto a canvas so they
 * are resized down to a reasonable max-side before being sent to the server as
 * a data URL, which keeps drafts small and avoids giant autosave payloads. The
 * server re-validates everything; resizing here is a bandwidth/UX feature.
 */

interface Props {
  draftId: string;
  assets: AssetState;
  expectedRevision: number;
  onSaved: (next: { assets: AssetState; revision: number }) => void;
  onError: (message: string) => void;
}

type UploadState = "idle" | "reading" | "resizing" | "uploading";

function acceptedAttr(): string {
  return Array.from(ACCEPTED_MIME_TYPES).join(",");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AssetUploader({
  draftId,
  assets,
  expectedRevision,
  onSaved,
  onError,
}: Props) {
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [logoState, setLogoState] = useState<UploadState>("idle");
  const [photoState, setPhotoState] = useState<UploadState>("idle");
  const [photoProgress, setPhotoProgress] = useState<string>("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Keep the latest revision in a ref so multiple sequential uploads always
  // send the latest value (useCallback would otherwise capture a stale one).
  const revisionRef = useRef<number>(expectedRevision);
  useEffect(() => {
    revisionRef.current = expectedRevision;
  }, [expectedRevision]);

  const doUploadOne = useCallback(
    async (
      kind: "logo" | "photo",
      file: File,
    ): Promise<{ assets: AssetState; revision: number }> => {
      if (!ACCEPTED_MIME_TYPES.has(file.type)) {
        throw new Error(
          "Unsupported file type. Pick a PNG, JPEG, WebP or GIF.",
        );
      }

      if (kind === "logo") {
        const approxFileSize = file.size;
        if (approxFileSize > MAX_LOGO_BYTES * 2) {
          // Give an early warning for obviously-huge files before resizing.
          // (Resize will usually bring them under the cap anyway.)
        }
      }

      if (kind === "photo") setPhotoState("reading");
      else setLogoState("reading");

      if (kind === "photo") setPhotoState("resizing");
      else setLogoState("resizing");

      const maxSide = kind === "logo" ? 600 : 1600;
      const resized = await resizeImage(file, maxSide, kind === "logo");
      const approxSize = await dataUrlByteLength(resized.dataUrl);
      const sizeLimit = kind === "logo" ? MAX_LOGO_BYTES : MAX_PHOTO_BYTES;
      if (approxSize > sizeLimit) {
        throw new Error(
          `${kind === "logo" ? "Logo" : "Photo"} is too large (${formatBytes(approxSize)}) even after resizing. Pick a smaller image — max ${Math.round(sizeLimit / 1024)} KB after resize.`,
        );
      }

      if (kind === "photo") setPhotoState("uploading");
      else setLogoState("uploading");

      const currentRevision = revisionRef.current;
      const response = await fetch(`/api/studio/drafts/${draftId}/assets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-valmont-csrf": csrfToken(),
        },
        body: JSON.stringify({
          kind,
          expectedRevision: currentRevision,
          image: {
            dataUrl: resized.dataUrl,
            fileName: file.name,
            mime: resized.mime,
            width: resized.width,
            height: resized.height,
          },
        }),
      });

      let data: {
        brief?: { assets?: AssetState };
        revision?: number;
        error?: string;
      } = {};
      try {
        data = (await response.json()) as typeof data;
      } catch {
        /* handled by !ok below */
      }
      if (!response.ok) {
        throw new Error(data.error ?? "Upload failed.");
      }
      if (!data.brief?.assets || typeof data.revision !== "number") {
        throw new Error("Server response was missing the updated assets.");
      }
      // Update our local revision immediately so the next upload in a batch
      // uses the new server revision rather than a stale captured value.
      revisionRef.current = data.revision;
      return { assets: data.brief.assets, revision: data.revision };
    },
    [draftId],
  );

  const uploadOne = useCallback(
    async (kind: "logo" | "photo", file: File): Promise<boolean> => {
      setUploadError(null);
      try {
        const result = await doUploadOne(kind, file);
        onSaved(result);
        setLogoState("idle");
        setPhotoState("idle");
        setPhotoProgress("");
        return true;
      } catch (cause) {
        setLogoState("idle");
        setPhotoState("idle");
        setPhotoProgress("");
        const message =
          cause instanceof Error ? cause.message : "Upload failed.";
        setUploadError(message);
        onError(message);
        return false;
      }
    },
    [doUploadOne, onSaved, onError],
  );

  const handleFile = useCallback(
    (kind: "logo" | "photo", fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      if (kind === "photo" && files.length > 1) {
        // Upload multiple photos sequentially. After each one resolves, the
        // parent re-renders us with fresh `assets` and `expectedRevision`, but
        // we also keep `revisionRef` in sync inside doUploadOne so that rapid
        // sequential calls here always use the newest revision.
        void (async () => {
          let succeeded = 0;
          let failed = 0;
          setPhotoState("uploading");
          for (let i = 0; i < files.length; i += 1) {
            const file = files[i]!;
            // Skip if we've already hit the max during this batch.
            if (succeeded >= MAX_PHOTOS) break;
            setPhotoProgress(`Uploading ${i + 1} of ${files.length}…`);
            const ok = await uploadOne("photo", file);
            if (ok) succeeded += 1;
            else {
              failed += 1;
              break;
            }
          }
          setPhotoState("idle");
          setPhotoProgress("");
          if (failed === 0 && succeeded > 0) {
            setUploadError(null);
          }
        })();
      } else {
        void uploadOne(kind, files[0]!);
      }
    },
    [uploadOne],
  );

  const remove = useCallback(
    async (target: "logo" | { photoIndex: number }) => {
      setUploadError(null);
      const key = target === "logo" ? "logo" : `photo-${target.photoIndex}`;
      setDeleting(key);
      try {
        const params = new URLSearchParams();
        if (target === "logo") {
          params.set("target", "logo");
        } else {
          params.set("target", "photo");
          params.set("photoIndex", String(target.photoIndex));
        }
        params.set("expectedRevision", String(revisionRef.current));
        const response = await fetch(
          `/api/studio/drafts/${draftId}/assets?${params.toString()}`,
          {
            method: "DELETE",
            headers: { "x-valmont-csrf": csrfToken() },
          },
        );
        let data: {
          brief?: { assets?: AssetState };
          revision?: number;
          error?: string;
        } = {};
        try {
          data = (await response.json()) as typeof data;
        } catch {
          /* handled by !ok below */
        }
        if (!response.ok) {
          throw new Error(data.error ?? "Remove failed.");
        }
        if (!data.brief?.assets || typeof data.revision !== "number") {
          throw new Error("Server response was missing the updated assets.");
        }
        revisionRef.current = data.revision;
        onSaved({ assets: data.brief.assets, revision: data.revision });
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Remove failed.";
        setUploadError(message);
        onError(message);
      } finally {
        setDeleting(null);
      }
    },
    [draftId, onSaved, onError],
  );

  const onPickFile = (kind: "logo" | "photo") => {
    const input =
      kind === "logo" ? logoInputRef.current : photoInputRef.current;
    if (input) {
      input.value = "";
      input.click();
    }
  };

  const isBusy =
    logoState !== "idle" || photoState !== "idle" || deleting !== null;

  return (
    <div className="grid gap-5">
      {/* Logo */}
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold text-navy">Business logo</h3>
        <p className="text-xs text-slate-500">
          Upload a PNG, JPEG or WebP. It will be shown in the preview header.
          Max {Math.round(MAX_LOGO_BYTES / 1024)} KB.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {assets.logo ? (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-white p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assets.logo.dataUrl}
                alt="Business logo"
                className="h-16 w-16 rounded-md object-contain ring-1 ring-line"
              />
              <div className="text-xs text-slate-600">
                <p className="font-semibold text-navy">
                  {assets.logo.fileName}
                </p>
                <p>
                  {assets.logo.width}×{assets.logo.height} ·{" "}
                  {formatBytes(assets.logo.size)}
                </p>
                <button
                  type="button"
                  onClick={() => remove("logo")}
                  disabled={isBusy}
                  data-testid="remove-logo"
                  className="mt-1 text-red-700 underline disabled:opacity-50"
                >
                  {deleting === "logo" ? "Removing…" : "Remove logo"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onPickFile("logo")}
              disabled={isBusy}
              data-testid="upload-logo"
              className="min-h-10 rounded-md border border-line bg-white px-3 text-sm font-semibold text-navy hover:bg-slate-50 disabled:opacity-60"
            >
              {logoState === "uploading"
                ? "Uploading…"
                : logoState === "resizing" || logoState === "reading"
                  ? "Preparing…"
                  : "Upload logo"}
            </button>
          )}
          <input
            ref={logoInputRef}
            type="file"
            accept={acceptedAttr()}
            className="hidden"
            onChange={(e) => handleFile("logo", e.target.files)}
          />
        </div>
      </section>

      {/* Photos */}
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold text-navy">Photos</h3>
        <p className="text-xs text-slate-500">
          Up to {MAX_PHOTOS} photos of the business, food or premises. Each is
          resized down to a 1600px long edge. Max{" "}
          {Math.round(MAX_PHOTO_BYTES / 1024)} KB each. You can select multiple
          photos at once.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onPickFile("photo")}
            disabled={isBusy || assets.photos.length >= MAX_PHOTOS}
            data-testid="upload-photo"
            className="min-h-10 rounded-md border border-line bg-white px-3 text-sm font-semibold text-navy hover:bg-slate-50 disabled:opacity-60"
          >
            {photoState === "uploading"
              ? photoProgress || "Uploading…"
              : photoState !== "idle"
                ? "Preparing…"
                : assets.photos.length >= MAX_PHOTOS
                  ? "Photo limit reached"
                  : "Add photo"}
          </button>
          <span className="text-xs text-slate-500">
            {assets.photos.length}/{MAX_PHOTOS}
          </span>
          <input
            ref={photoInputRef}
            type="file"
            accept={acceptedAttr()}
            multiple
            className="hidden"
            onChange={(e) => handleFile("photo", e.target.files)}
          />
        </div>

        {assets.photos.length > 0 && (
          <ul
            data-testid="photo-gallery"
            className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3"
          >
            {assets.photos.map((photo: StoredImage, i: number) => (
              <li
                key={`${photo.fileName}-${i}`}
                className="relative overflow-hidden rounded-lg border border-line bg-white"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.dataUrl}
                  alt={photo.fileName}
                  className="aspect-[4/3] w-full object-cover"
                />
                <div className="flex items-center justify-between gap-2 p-2 text-[11px] text-slate-600">
                  <span className="truncate">{photo.fileName}</span>
                  <button
                    type="button"
                    onClick={() => remove({ photoIndex: i })}
                    disabled={isBusy}
                    data-testid={`remove-photo-${i}`}
                    className="shrink-0 text-red-700 underline disabled:opacity-50"
                  >
                    {deleting === `photo-${i}` ? "Removing…" : "Remove"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {uploadError && (
        <p role="alert" className="text-xs text-red-700">
          {uploadError}
        </p>
      )}
    </div>
  );
}
