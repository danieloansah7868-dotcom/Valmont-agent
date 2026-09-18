/**
 * Brand kit logo upgrade — upload validation and brand sheet with custom logo.
 *
 * Tests the new 10MB PNG/JPEG/WebP upload path (client + server validated)
 * and that an uploaded logo appears in the brand sheet. SVG uploads are
 * intentionally not accepted — we leave SVG out to keep logos safe, and we
 * test that rejection.
 */
import { describe, expect, it } from "vitest";
import { validateUploadedImage } from "./asset-validation";
import { MAX_LOGO_BYTES } from "./assets";
import { brandSheetDataForBrief } from "./brand-sheet";
import { createDefaultBrief } from "./site-brief/defaults";
import type { SiteBriefV1 } from "./site-brief/schema";

// Minimal valid PNG (1x1) base64 — same as brand-kit-routes.test.ts mock
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

// Minimal valid JPEG magic — FF D8 FF — plus some payload
function jpegDataUrl(size = 100): string {
  const bytes = Buffer.alloc(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  // Fill rest with zeros
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function webpDataUrl(size = 100): string {
  const bytes = Buffer.alloc(size);
  // RIFF....WEBP
  bytes[0] = 0x52; // R
  bytes[1] = 0x49; // I
  bytes[2] = 0x46; // F
  bytes[3] = 0x46; // F
  bytes[8] = 0x57; // W
  bytes[9] = 0x45; // E
  bytes[10] = 0x42; // B
  bytes[11] = 0x50; // P
  return `data:image/webp;base64,${bytes.toString("base64")}`;
}

describe("custom logo upload — accepts valid files", () => {
  it("accepts PNG up to 10MB", () => {
    expect(MAX_LOGO_BYTES).toBe(10 * 1024 * 1024);
    const image = validateUploadedImage({
      kind: "logo",
      dataUrl: PNG_DATA_URL,
      fileName: "my-logo.png",
      mime: "image/png",
      width: 600,
      height: 160,
    });
    expect(image.mime).toBe("image/png");
    expect(image.size).toBeGreaterThan(0);
  });

  it("accepts JPEG and WebP", () => {
    const jpeg = validateUploadedImage({
      kind: "logo",
      dataUrl: jpegDataUrl(200),
      fileName: "logo.jpg",
      mime: "image/jpeg",
      width: 800,
      height: 600,
    });
    expect(jpeg.mime).toBe("image/jpeg");

    const webp = validateUploadedImage({
      kind: "logo",
      dataUrl: webpDataUrl(200),
      fileName: "logo.webp",
      mime: "image/webp",
      width: 800,
      height: 600,
    });
    expect(webp.mime).toBe("image/webp");
  });
});

describe("custom logo upload — rejects oversize and wrong type", () => {
  it("rejects oversize with plain-English message", () => {
    // Create a PNG data URL whose decoded bytes exceed 10MB
    // We don't need to allocate full 10MB in test — mock size check via dataUrl length?
    // Instead, we craft a valid PNG header but with large base64 payload that decodes to >10MB.
    // For speed, we directly test the size check by passing a dataUrl that decodes to 11MB.
    // Allocate 11MB buffer with PNG magic.
    const oversize = 11 * 1024 * 1024;
    const bytes = Buffer.alloc(oversize);
    bytes[0] = 0x89;
    bytes[1] = 0x50;
    bytes[2] = 0x4e;
    bytes[3] = 0x47;
    bytes[4] = 0x0d;
    bytes[5] = 0x0a;
    bytes[6] = 0x1a;
    bytes[7] = 0x0a;
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;

    expect(() =>
      validateUploadedImage({
        kind: "logo",
        dataUrl,
        fileName: "huge.png",
        mime: "image/png",
        width: 600,
        height: 160,
      }),
    ).toThrow(/That file is too large — logos can be up to 10MB/);
  });

  it("rejects wrong type with plain-English message", () => {
    expect(() =>
      validateUploadedImage({
        kind: "logo",
        dataUrl: PNG_DATA_URL,
        fileName: "logo.gif",
        mime: "image/gif",
        width: 600,
        height: 160,
      }),
    ).toThrow(/That file type is not supported — use PNG, JPEG or WebP/);

    expect(() =>
      validateUploadedImage({
        kind: "logo",
        dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        fileName: "logo.svg",
        mime: "image/svg+xml",
        width: 600,
        height: 160,
      }),
    ).toThrow(/That file type is not supported/);
  });

  it("rejects malicious SVG if someone tries to smuggle it as PNG mime (magic mismatch)", () => {
    // Data URL claims PNG but content is SVG text — magic check should fail
    const svgPayload = Buffer.from("<svg><script>alert(1)</script></svg>");
    const dataUrl = `data:image/png;base64,${svgPayload.toString("base64")}`;
    expect(() =>
      validateUploadedImage({
        kind: "logo",
        dataUrl,
        fileName: "evil.png",
        mime: "image/png",
        width: 600,
        height: 160,
      }),
    ).toThrow(/File contents do not match the image type/);
  });
});

describe("uploaded logo appears in brand sheet", () => {
  it("brandSheetDataForBrief uses uploaded logo dataUrl", () => {
    const brief = createDefaultBrief({
      businessName: "Adom Mart",
      tagline: "Everyday essentials",
    }) as SiteBriefV1;
    // Simulate uploaded logo in assets
    (
      brief as unknown as { assets: { logo: unknown; photos: unknown[] } }
    ).assets = {
      logo: {
        dataUrl: PNG_DATA_URL,
        fileName: "custom-logo.png",
        mime: "image/png",
        width: 600,
        height: 160,
        size: 100,
      },
      photos: [],
    };

    const sheet = brandSheetDataForBrief(brief);
    expect(sheet.logoDataUrl).toBe(PNG_DATA_URL);
    expect(sheet.name).toBe("Adom Mart");
  });
});
