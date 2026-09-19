// @vitest-environment jsdom
/**
 * The Brand kit card has two halves. The AI half (four questions, then name
 * and palette ideas) is transient: it only exists after a successful suggest.
 * The offline half — "Design the logo yourself" — must be there before any
 * suggestion exists, because while the model provider is degraded "Suggest a
 * brand" is dead and these tools are the only logo the agency can produce.
 *
 * Rendering the real component in jsdom is the point: this is a reachability
 * bug in the JSX, not in any route, so nothing below the component can catch
 * it. The fetch layer is stubbed; no server is started.
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandKitCard } from "./brand-kit";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { getTheme } from "@/lib/studio/themes";
import type { SiteBriefV1, StudioDraft } from "@/lib/studio/site-brief/schema";
import type { StoredImage } from "@/lib/studio/assets";
import type {
  BrandKitNameSuggestion,
  BrandKitPalette,
} from "@/lib/studio/brand-kit";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT_ID = "0f1c8a4e-2b3d-4a5f-9c7e-1a2b3c4d5e6f";
const REVISION = 4;

/** The one sentence the failure copy must carry (see DIY_TOOLS_STILL_WORK). */
const DIY_SENTENCE = "logo tools below still work without the AI";

const SUCCESSFUL_SUGGEST: {
  names: BrandKitNameSuggestion[];
  palettes: BrandKitPalette[];
} = {
  names: [
    {
      name: "Adom Fresh Foods",
      meaning: "Grace and good food, twice over.",
      tagline: "Grace in every meal",
      slug: "adom-fresh-foods",
      domainCandidates: ["adomfreshfoods.com", "adomfresh.gh"],
      checkLinks: {
        instagram: "https://instagram.com/explore/tags/adomfreshfoods",
        tiktok: "https://www.tiktok.com/search?q=adomfreshfoods",
        whois: "https://www.whois.com/whois/adomfreshfoods.com",
      },
    },
  ],
  palettes: [
    {
      label: "Market Warmth",
      primary: "#123456",
      accent: "#ABCDEF",
      surface: "#F1F1F1",
      text: "#111111",
      themeId: "friendly-colourful",
    },
  ],
};

const STORED_LOGO: StoredImage = {
  dataUrl: "data:image/png;base64,aGVsbG8=",
  fileName: "adom-logo.png",
  mime: "image/png",
  width: 240,
  height: 120,
  size: 2048,
};

const mounted: Root[] = [];

/**
 * Stands in for the wizard: it owns the stored brief and adopts whatever a
 * route returns, exactly as `adoptServerDraft` does on the real page.
 */
function Harness({ initialBrief }: { initialBrief: SiteBriefV1 }) {
  const [brief, setBrief] = useState(initialBrief);
  const [revision, setRevision] = useState(REVISION);
  return createElement(BrandKitCard, {
    draftId: DRAFT_ID,
    brief,
    expectedRevision: revision,
    onDraftUpdated: (draft: StudioDraft) => {
      setBrief(draft.brief);
      setRevision(draft.revision);
    },
    onAddonChange: () => {},
  });
}

async function mountCard(brief: SiteBriefV1): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(Harness, { initialBrief: brief }));
  });
  return container;
}

/** The card starts collapsed; everything below lives inside it. */
async function openCard(container: HTMLElement): Promise<void> {
  await clickTestId(container, "brand-kit-open");
}

async function clickTestId(container: HTMLElement, testId: string) {
  const element = queryTestId(container, testId);
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function queryTestId(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid='${testId}']`,
  );
  if (!element) throw new Error(`No element with data-testid=${testId}`);
  return element;
}

function maybeTestId(
  container: HTMLElement,
  testId: string,
): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid='${testId}']`);
}

/** React only sees a programmatic change if it is written through the setter. */
async function setFieldValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

/** The query string of one of the three live previews. */
function previewParams(
  container: HTMLElement,
  layout: string,
): URLSearchParams {
  const image = queryTestId(
    container,
    `brand-logo-preview-${layout}`,
  ) as HTMLImageElement;
  const src = image.getAttribute("src");
  if (!src) throw new Error(`Preview ${layout} has no src`);
  return new URLSearchParams(src.slice(src.indexOf("?") + 1));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers the suggest form so the paid button becomes clickable. */
async function answerQuestions(container: HTMLElement): Promise<void> {
  await setFieldValue(
    container.querySelector<HTMLInputElement>("#brand-what")!,
    "Fresh kenkey and fish",
  );
  await setFieldValue(
    container.querySelector<HTMLInputElement>("#brand-town")!,
    "Koforidua",
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("Brand kit — the DIY logo tools", () => {
  it("renders icon, font, layouts, upload and sheet with no suggestion present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const container = await mountCard(createDefaultBrief());
    await openCard(container);

    // The AI half has produced nothing, and that must not matter.
    expect(container.textContent).not.toContain("Name ideas");
    expect(container.textContent).not.toContain("Colour palettes");

    const diy = queryTestId(container, "brand-kit-diy");
    expect(diy.textContent).toContain("Design the logo yourself");

    const icon = queryTestId(container, "brand-logo-icon");
    const font = queryTestId(container, "brand-logo-font");
    expect(icon.tagName).toBe("SELECT");
    expect(font.tagName).toBe("SELECT");

    const theme = getTheme("clean-corporate")!;
    for (const layout of ["wordmark", "badge", "stacked"]) {
      const preview = queryTestId(
        container,
        `brand-logo-preview-${layout}`,
      ) as HTMLImageElement;
      const params = previewParams(container, layout);
      expect(params.get("layout")).toBe(layout);
      // No name suggestion has been applied, so the stored brief is the fallback.
      expect(params.get("name")).toBe("My business");
      // Nor any palette: the card falls back to the current theme's colours.
      expect(params.get("primary")).toBe(theme.tokens.colors.primary);
      expect(params.get("accent")).toBe(theme.tokens.colors.accent);
      expect(params.get("surface")).toBe(theme.tokens.colors.surface);
      expect(preview.getAttribute("alt")).toContain("My business");
      expect(
        queryTestId(container, `brand-logo-${layout}`).textContent,
      ).toContain("Save as logo");
    }

    expect(queryTestId(container, "upload-custom-logo").textContent).toContain(
      "Upload logo",
    );
    expect(queryTestId(container, "brand-kit-sheet")).not.toBeNull();
    // Nothing on this path may call the model.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the DIY tools when the suggest call fails, and says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error:
              "The model provider failed to generate brand suggestions. Check your model settings in Settings (/settings) or try again.",
          },
          502,
        ),
      ),
    );

    const container = await mountCard(createDefaultBrief());
    await openCard(container);
    await answerQuestions(container);
    await clickTestId(container, "brand-kit-suggest");

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("The model provider failed");
    expect(alert?.textContent).toContain(DIY_SENTENCE);

    // The degraded provider took nothing with it: every offline tool survives.
    expect(queryTestId(container, "brand-kit-diy")).not.toBeNull();
    expect(
      queryTestId(container, "brand-logo-preview-wordmark"),
    ).not.toBeNull();
    expect(queryTestId(container, "upload-custom-logo")).not.toBeNull();
    expect(queryTestId(container, "brand-kit-sheet")).not.toBeNull();
  });

  it("keeps the DIY tools when the model key is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error:
              "MODEL_API_KEY is not configured. Visit Settings (/settings) to configure your model provider.",
          },
          503,
        ),
      ),
    );

    const container = await mountCard(createDefaultBrief());
    await openCard(container);
    await answerQuestions(container);
    await clickTestId(container, "brand-kit-suggest");

    const status = container.querySelector("[role='status']");
    expect(status?.textContent).toContain("MODEL_API_KEY is not configured");
    expect(status?.textContent).toContain(DIY_SENTENCE);

    // The four questions are gone (no point), the logo tools are not.
    expect(maybeTestId(container, "brand-kit-suggest")).toBeNull();
    expect(queryTestId(container, "brand-kit-diy")).not.toBeNull();
    expect(queryTestId(container, "brand-logo-preview-badge")).not.toBeNull();
  });

  it("renders the friendly 504 timeout copy, and keeps the DIY tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error:
              "The AI is taking too long right now — the model provider is busy or slow. Wait a minute and try again.",
          },
          504,
        ),
      ),
    );

    const container = await mountCard(createDefaultBrief());
    await openCard(container);
    await answerQuestions(container);
    await clickTestId(container, "brand-kit-suggest");

    const alert = container.querySelector("[role='alert']");
    // The honest timeout copy: too long, provider busy, wait and retry …
    expect(alert?.textContent).toContain("taking too long");
    expect(alert?.textContent).toContain("Wait a minute and try again");
    // … plus the standing reassurance that the offline tools survived.
    expect(alert?.textContent).toContain(DIY_SENTENCE);
    // And the old naked shrug is gone from the card.
    expect(container.textContent).not.toContain("Something went wrong");

    // A slow provider is not a dead provider: every offline tool survives.
    expect(queryTestId(container, "brand-kit-diy")).not.toBeNull();
    expect(
      queryTestId(container, "brand-logo-preview-wordmark"),
    ).not.toBeNull();
    expect(queryTestId(container, "upload-custom-logo")).not.toBeNull();
    expect(queryTestId(container, "brand-kit-sheet")).not.toBeNull();
  });

  it("renders honest, retry-safe copy for an unknown server error — no shrug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error:
              "Something unexpected happened on our side. It is safe to try again.",
          },
          500,
        ),
      ),
    );

    const container = await mountCard(createDefaultBrief());
    await openCard(container);
    await answerQuestions(container);
    await clickTestId(container, "brand-kit-suggest");

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("unexpected");
    expect(alert?.textContent).toContain("safe to try again");
    expect(alert?.textContent).toContain(DIY_SENTENCE);
    expect(container.textContent).not.toContain("Something went wrong");

    expect(queryTestId(container, "brand-kit-diy")).not.toBeNull();
  });

  it("is still honest when the browser itself cannot reach the server", async () => {
    // Not an ApiError at all — the fetch never got a response (offline, a
    // proxy gave up, or the call's own client-side timeout fired).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const container = await mountCard(createDefaultBrief());
    await openCard(container);
    await answerQuestions(container);
    await clickTestId(container, "brand-kit-suggest");

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain(
      "Something unexpected happened while we were talking to the server",
    );
    expect(alert?.textContent).toContain("safe to try again");
    expect(alert?.textContent).toContain(DIY_SENTENCE);
    expect(container.textContent).not.toContain("Something went wrong");

    expect(queryTestId(container, "brand-kit-diy")).not.toBeNull();
  });

  it("redraws all three previews when the icon or the font changes", async () => {
    const container = await mountCard(createDefaultBrief());
    await openCard(container);

    expect(previewParams(container, "wordmark").get("icon")).toBe("none");

    await setFieldValue(
      queryTestId(container, "brand-logo-icon") as HTMLSelectElement,
      "fish",
    );
    await setFieldValue(
      queryTestId(container, "brand-logo-font") as HTMLSelectElement,
      "classic",
    );

    for (const layout of ["wordmark", "badge", "stacked"]) {
      const params = previewParams(container, layout);
      expect(params.get("icon")).toBe("fish");
      expect(params.get("font")).toBe("classic");
    }
  });

  it("refreshes the DIY previews when a suggested palette is applied", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/suggest")) return jsonResponse(SUCCESSFUL_SUGGEST);
        if (url.endsWith("/apply")) {
          const body = JSON.parse(String(init?.body)) as {
            palette: {
              themeId: string;
              primary: string;
              accent: string;
              surface: string;
            };
          };
          return jsonResponse({
            id: DRAFT_ID,
            ownerId: "owner-1",
            schemaVersion: 1,
            templateRegistryVersion: 1,
            themeRegistryVersion: 1,
            revision: REVISION + 1,
            createdAt: "2026-09-18T00:00:00.000Z",
            updatedAt: "2026-09-18T00:00:00.000Z",
            // Parsed the way the apply route parses it, theme id and all.
            brief: siteBriefSchemaV1.parse({
              ...createDefaultBrief(),
              selectedTheme: body.palette.themeId,
              preferredColours: [
                body.palette.primary,
                body.palette.accent,
                body.palette.surface,
              ],
            }),
          } satisfies StudioDraft);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const container = await mountCard(createDefaultBrief());
    await openCard(container);
    await answerQuestions(container);
    await clickTestId(container, "brand-kit-suggest");

    // The AI half arrived as usual.
    expect(queryTestId(container, "brand-name-0").textContent).toContain(
      "Adom Fresh Foods",
    );

    await clickTestId(container, "brand-palette-use-0");

    const palette = SUCCESSFUL_SUGGEST.palettes[0]!;
    for (const layout of ["wordmark", "badge", "stacked"]) {
      const params = previewParams(container, layout);
      expect(params.get("primary")).toBe(palette.primary);
      expect(params.get("accent")).toBe(palette.accent);
      expect(params.get("surface")).toBe(palette.surface);
    }
  });

  it("renders the saved logo, and its replace/remove actions, on load", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const container = await mountCard(
      createDefaultBrief({
        assets: { logo: STORED_LOGO, photos: [] },
        preferredColours: ["#123456", "#ABCDEF", "#F1F1F1"],
      }),
    );
    await openCard(container);

    const preview = queryTestId(
      container,
      "custom-logo-preview",
    ) as HTMLImageElement;
    expect(preview.getAttribute("src")).toBe(STORED_LOGO.dataUrl);
    expect(preview.getAttribute("alt")).toBe("Current logo");
    expect(container.textContent).toContain(STORED_LOGO.fileName);
    expect(container.textContent).toContain("240×120");
    expect(queryTestId(container, "remove-custom-logo")).not.toBeNull();
    expect(queryTestId(container, "upload-custom-logo").textContent).toContain(
      "Replace logo",
    );
    // Straight from the stored brief: nobody had to interact to get here.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
