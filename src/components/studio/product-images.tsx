"use client";

import { useRef, useState } from "react";
import type { CatalogItem } from "@/lib/studio/site-brief/schema";
import { ACCEPTED_MIME_TYPES } from "@/lib/studio/assets";
import { dataUrlByteLength, resizeImage } from "./resize-image";

const MAX_PRODUCT_IMAGE_BYTES = 400 * 1024;

export function ProductImagesEditor({
  items,
  onChange,
}: {
  items: CatalogItem[];
  onChange: (items: CatalogItem[]) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const targetId = useRef<string | null>(null);

  if (items.length === 0) return null;

  function move(index: number, direction: -1 | 1) {
    const next = [...items];
    const swap = index + direction;
    if (swap < 0 || swap >= next.length) return;
    const current = next[index]!;
    next[index] = next[swap]!;
    next[swap] = current;
    onChange(next);
  }

  async function onFile(file: File | undefined, itemId: string) {
    if (!file) return;
    if (!ACCEPTED_MIME_TYPES.has(file.type)) {
      setError("Pick a PNG, JPEG, WebP or GIF.");
      return;
    }
    setBusyId(itemId);
    setError(null);
    try {
      const resized = await resizeImage(file, 800, false);
      const size = await dataUrlByteLength(resized.dataUrl);
      if (size > MAX_PRODUCT_IMAGE_BYTES) {
        throw new Error("That photo is still too large after shrinking.");
      }
      onChange(
        items.map((item) =>
          item.id === itemId ? { ...item, image: resized.dataUrl } : item,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add photo.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-white p-3">
      <h3 className="text-sm font-semibold text-navy">Product photos</h3>
      <p className="text-xs text-slate-500">
        Add a photo for each item. Customers see it on the menu, in the basket
        and on the order. Use the arrows to change the order.
      </p>
      <ul className="grid gap-2" data-testid="product-image-list">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-lg border border-line p-2"
          >
            {item.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.image}
                alt=""
                className="size-14 rounded-md object-cover ring-1 ring-line"
              />
            ) : (
              <span className="flex size-14 items-center justify-center rounded-md bg-ivory-100 text-[10px] text-slate-500">
                No photo
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-navy">
                {item.name}
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="text-xs font-semibold text-brandblue underline"
                  disabled={busyId === item.id}
                  onClick={() => {
                    targetId.current = item.id;
                    if (inputRef.current) {
                      inputRef.current.value = "";
                      inputRef.current.click();
                    }
                  }}
                >
                  {busyId === item.id
                    ? "Adding…"
                    : item.image
                      ? "Change photo"
                      : "Add photo"}
                </button>
                {item.image && (
                  <button
                    type="button"
                    className="text-xs text-red-700 underline"
                    onClick={() =>
                      onChange(
                        items.map((entry) =>
                          entry.id === item.id
                            ? { ...entry, image: undefined }
                            : entry,
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                aria-label={`Move ${item.name} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                className="min-h-8 w-8 rounded-md border border-line text-sm disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${item.name} down`}
                disabled={index === items.length - 1}
                onClick={() => move(index, 1)}
                className="min-h-8 w-8 rounded-md border border-line text-sm disabled:opacity-40"
              >
                ↓
              </button>
            </div>
          </li>
        ))}
      </ul>
      <input
        ref={inputRef}
        type="file"
        accept={Array.from(ACCEPTED_MIME_TYPES).join(",")}
        className="hidden"
        onChange={(event) => {
          const id = targetId.current;
          if (id) void onFile(event.target.files?.[0], id);
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
