/**
 * Client-side image resize used by logo, photo and product-image uploads.
 * The server still re-validates; this only keeps drafts small.
 */

export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("Could not read this file from your computer."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(
          new Error(
            "Could not read this image. It may be corrupt or in an unsupported format.",
          ),
        );
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export async function resizeImage(
  file: File,
  maxSide: number,
  preferPng: boolean,
): Promise<{ dataUrl: string; width: number; height: number; mime: string }> {
  const img = await loadImage(file);
  const origW = img.naturalWidth;
  const origH = img.naturalHeight;
  let w = origW;
  let h = origH;
  if (Math.max(w, h) > maxSide) {
    if (w >= h) {
      h = Math.round((h * maxSide) / w);
      w = maxSide;
    } else {
      w = Math.round((w * maxSide) / h);
      h = maxSide;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.drawImage(img, 0, 0, w, h);

  const sourceMime = file.type || "image/jpeg";
  if (sourceMime === "image/webp") {
    const webp = canvas.toDataURL("image/webp", 0.82);
    if (webp.startsWith("data:image/webp")) {
      return { dataUrl: webp, width: w, height: h, mime: "image/webp" };
    }
  }
  if (preferPng && sourceMime !== "image/jpeg") {
    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: w,
      height: h,
      mime: "image/png",
    };
  }
  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.82),
    width: w,
    height: h,
    mime: "image/jpeg",
  };
}

export async function dataUrlByteLength(dataUrl: string): Promise<number> {
  const comma = dataUrl.indexOf(",");
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.match(/=*$/)?.[0]?.length ?? 0;
  return Math.round((b64.length * 3) / 4) - padding;
}
