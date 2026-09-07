/**
 * Stage B — the Brand Kit suggestion engine, tested with a fake
 * ModelProvider. No test here ever reaches a real model: the fake records
 * the request (so prompt, temperature, token cap and timeout are asserted)
 * and answers canned structured output through the request's own validator.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ModelProvider,
  ModelResponse,
  StructuredRequest,
} from "@/lib/models/types";
import {
  BRAND_KIT_FEELINGS,
  BRAND_KIT_MAX_TOKENS,
  BRAND_KIT_SUGGESTS_PER_HOUR,
  BRAND_KIT_TEMPERATURE,
  assertBrandKitSuggestRateLimit,
  brandKitInputSchema,
  brandKitMessages,
  brandSlug,
  checkLinks,
  contrastRatio,
  domainCandidates,
  fixPaletteContrast,
  nameIsBlocked,
  readableTextOn,
  suggestBrandKit,
  type BrandKitOutput,
  type BrandKitPalette,
} from "./brand-kit";
import { RateLimitError } from "@/lib/api-errors";
import { resetRateLimitForTests } from "@/lib/security";
import { THEME_IDS } from "./themes";

/** A palette that always passes validation and already reads well. */
function palette(overrides: Partial<BrandKitPalette> = {}): BrandKitPalette {
  return {
    label: "Market morning",
    primary: "#0A1F44",
    accent: "#E8822B",
    surface: "#F8F6F0",
    text: "#0A1F44",
    themeId: "modern-bold",
    ...overrides,
  };
}

function makeOutput(
  names: string[],
  palettes?: BrandKitPalette[],
): BrandKitOutput {
  return {
    names: names.map((name, index) => ({
      name,
      meaning: `Meaning ${index + 1} for ${name}`,
      tagline: `Tagline for ${name}`,
    })),
    palettes: palettes ?? [
      palette({ label: "One" }),
      palette({ label: "Two" }),
      palette({ label: "Three" }),
    ],
  };
}

const BASE_INPUT = {
  whatTheySell: "Second-hand clothes and shoes",
  town: "Koforidua",
  feeling: "friendly" as const,
  category: "online-shop",
};

/** A provider that answers each call from `outputs`, recording requests. */
function fakeProvider(outputs: BrandKitOutput[]) {
  const requests: StructuredRequest<unknown>[] = [];
  const provider: ModelProvider = {
    id: "fake",
    model: "fake-1",
    supportsStreaming: false,
    chat: () => {
      throw new Error("not used by the brand kit");
    },
    structured: async <T>(
      request: StructuredRequest<T>,
    ): Promise<ModelResponse & { data: T }> => {
      requests.push(request as StructuredRequest<unknown>);
      const output =
        outputs[Math.min(requests.length - 1, outputs.length - 1)]!;
      return {
        content: JSON.stringify(output),
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        model: "fake-1",
        provider: "fake",
        finishReason: "stop",
        data: request.validate(output),
      };
    },
    stream(): AsyncIterable<never> {
      throw new Error("not used by the brand kit");
    },
  };
  return { provider, requests };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("brand kit input validation", () => {
  it("accepts the four answers with the language default", () => {
    const parsed = brandKitInputSchema.parse(BASE_INPUT);
    expect(parsed.language).toBe("en");
    expect(parsed.feeling).toBe("friendly");
  });

  it("rejects an over-long story and an over-long town", () => {
    expect(
      brandKitInputSchema.safeParse({
        ...BASE_INPUT,
        whatTheySell: "x".repeat(301),
      }).success,
    ).toBe(false);
    expect(
      brandKitInputSchema.safeParse({ ...BASE_INPUT, town: "y".repeat(61) })
        .success,
    ).toBe(false);
  });

  it("rejects a feeling outside the four moods", () => {
    expect(
      brandKitInputSchema.safeParse({ ...BASE_INPUT, feeling: "mysterious" })
        .success,
    ).toBe(false);
    for (const feeling of BRAND_KIT_FEELINGS) {
      expect(
        brandKitInputSchema.safeParse({ ...BASE_INPUT, feeling }).success,
      ).toBe(true);
    }
  });

  it("rejects more than three must-include words or a 21-char word", () => {
    expect(
      brandKitInputSchema.safeParse({
        ...BASE_INPUT,
        mustInclude: ["one", "two", "three", "four"],
      }).success,
    ).toBe(false);
    expect(
      brandKitInputSchema.safeParse({
        ...BASE_INPUT,
        mustInclude: ["z".repeat(21)],
      }).success,
    ).toBe(false);
    expect(
      brandKitInputSchema.safeParse({
        ...BASE_INPUT,
        mustInclude: ["adom", "gold"],
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown website category", () => {
    expect(
      brandKitInputSchema.safeParse({ ...BASE_INPUT, category: "spy-shop" })
        .success,
    ).toBe(false);
  });
});

describe("suggestBrandKit — the model call itself", () => {
  it("parses the fake provider's output into names with slugs, domains and links", async () => {
    const output = makeOutput([
      "Adom Mart",
      "Adepa Styles",
      "Kof Corner",
      "Nhyira Press",
      "Oseikrom Deals",
    ]);
    const { provider, requests } = fakeProvider([output]);

    const suggestion = await suggestBrandKit(BASE_INPUT, provider);

    expect(requests).toHaveLength(1);
    expect(suggestion.names).toHaveLength(5);
    const first = suggestion.names[0]!;
    expect(first.name).toBe("Adom Mart");
    expect(first.slug).toBe("adommart");
    expect(first.domainCandidates).toEqual(["adommart.com", "adommart.com.gh"]);
    expect(first.checkLinks.instagram).toBe(
      "https://www.instagram.com/adommart/",
    );
    expect(first.checkLinks.tiktok).toBe("https://www.tiktok.com/@adommart");
    expect(first.checkLinks.whois).toBe(
      "https://www.whois.com/whois/adommart.com",
    );
    expect(suggestion.palettes).toHaveLength(3);
  });

  it("asks the model with the agreed budget: temperature 0.8, 1200 tokens, a timeout", async () => {
    const output = makeOutput([
      "Adom Mart",
      "Adepa Styles",
      "Kof Corner",
      "Nhyira Press",
      "Oseikrom Deals",
    ]);
    const { provider, requests } = fakeProvider([output]);

    await suggestBrandKit(BASE_INPUT, provider);

    const request = requests[0]!;
    expect(request.temperature).toBe(BRAND_KIT_TEMPERATURE);
    expect(BRAND_KIT_TEMPERATURE).toBe(0.8);
    expect(request.maxTokens).toBe(BRAND_KIT_MAX_TOKENS);
    expect(BRAND_KIT_MAX_TOKENS).toBe(1200);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("reclassifies a model answer that fails validation as a server error, not a 400", async () => {
    const output = {
      names: [],
      palettes: [],
    } as unknown as BrandKitOutput;
    const { provider, requests } = fakeProvider([output]);

    let caught: unknown;
    try {
      await suggestBrandKit(BASE_INPUT, provider);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(z.ZodError);
    expect(String((caught as Error).message)).toContain("could not use");
    // The retry never even happened: a broken answer is not filtered, it fails.
    expect(requests).toHaveLength(1);
  });

  it("sends the model only the four answers — never env keys or other business data", async () => {
    process.env.MODEL_API_KEY = "super-secret-key";
    const output = makeOutput([
      "Adom Mart",
      "Adepa Styles",
      "Kof Corner",
      "Nhyira Press",
      "Oseikrom Deals",
    ]);
    const { provider, requests } = fakeProvider([output]);

    await suggestBrandKit(
      {
        ...BASE_INPUT,
        mustInclude: ["adom"],
        adminEmail: "owner@private.example",
        phone: "+233240000001",
      },
      provider,
    );

    const request = requests[0]!;
    const allText = request.messages.map((m) => m.content).join("\n");
    expect(allText).toContain("Second-hand clothes and shoes");
    expect(allText).toContain("Koforidua");
    expect(allText).toContain("friendly");
    expect(allText).toContain("adom");
    expect(allText).not.toContain("super-secret-key");
    expect(allText).not.toContain("owner@private.example");
    expect(allText).not.toContain("+233240000001");
    // Worded for the job: Ghana context, radio-friendly names, no emojis.
    expect(allText.toLowerCase()).toContain("ghana");
    expect(allText.toLowerCase()).toContain("radio");
    expect(allText.toLowerCase()).toContain("domain");
    expect(allText.toLowerCase()).toContain("no emojis");
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("suggestBrandKit — protected brands, duplicates and the one re-ask", () => {
  it("drops names copying protected brands and duplicates without re-asking at 3+", async () => {
    const output = makeOutput([
      "MTN Data Hub",
      "Vodafone Ventures",
      "Adom Mart",
      "Adom Mart",
      "Adepa Styles",
    ]);
    const { provider, requests } = fakeProvider([output]);

    const suggestion = await suggestBrandKit(BASE_INPUT, provider);

    expect(suggestion.names.map((n) => n.name)).toEqual([
      "Adom Mart",
      "Adepa Styles",
    ]);
    // Two survivors: below three, so exactly one more ask happened.
    expect(requests).toHaveLength(2);
  });

  it("does not re-ask once three names survive", async () => {
    const firstBatch = makeOutput([
      "Telecel Shop",
      "Ghana Card Deals",
      "Adom Mart",
      "Adepa Styles",
      "Kof Corner",
    ]);
    const secondBatch = makeOutput([
      "GhanaPost Delivery",
      "AT Mobile Money",
      "Nhyira Press",
      "Oseikrom Deals",
      "Starlink Weaving",
    ]);
    const { provider, requests } = fakeProvider([firstBatch, secondBatch]);

    const suggestion = await suggestBrandKit(BASE_INPUT, provider);

    // Three first-batch names survived, so the second batch was never spent:
    // one call only, and none of its names appear.
    expect(requests).toHaveLength(1);
    expect(suggestion.names.map((n) => n.name)).toEqual([
      "Adom Mart",
      "Adepa Styles",
      "Kof Corner",
    ]);
  });

  it("re-asks when fewer than three survive, merges and dedupes both batches", async () => {
    const firstBatch = makeOutput([
      "MTN Pro",
      "Adom Mart",
      "AirtelTigo Deals",
      "Adom Mart",
      "GCB Ventures",
    ]);
    const secondBatch = makeOutput([
      "Adom Mart",
      "Adepa Styles",
      "Kof Corner",
      "Nhyira Press",
      "Oseikrom Deals",
    ]);
    const { provider, requests } = fakeProvider([firstBatch, secondBatch]);

    const suggestion = await suggestBrandKit(BASE_INPUT, provider);

    expect(requests).toHaveLength(2);
    expect(suggestion.names.map((n) => n.name)).toEqual([
      "Adom Mart",
      "Adepa Styles",
      "Kof Corner",
      "Nhyira Press",
      "Oseikrom Deals",
    ]);
  });

  it("never asks a third time — two calls maximum, whatever survives", async () => {
    const blocked = makeOutput([
      "MTN One",
      "MTN Two",
      "MTN Three",
      "MTN Four",
      "Adom Mart",
    ]);
    const { provider, requests } = fakeProvider([blocked, blocked]);

    const suggestion = await suggestBrandKit(BASE_INPUT, provider);

    expect(requests).toHaveLength(2);
    expect(suggestion.names.map((n) => n.name)).toEqual(["Adom Mart"]);
  });

  it("matches protected brands by word, and by squashed form for long terms", () => {
    expect(nameIsBlocked("MTN Data Hub")).toBe(true);
    expect(nameIsBlocked("MyMTNShop")).toBe(true);
    expect(nameIsBlocked("Airtel Tigo Deals")).toBe(true);
    expect(nameIsBlocked("AT Mobile Money")).toBe(true);
    expect(nameIsBlocked("Ghana Card Plus")).toBe(true);
    expect(nameIsBlocked("GhanaPost Delivery")).toBe(true);
    // Word-based matching must not block innocent names containing "at".
    expect(nameIsBlocked("Data Hub")).toBe(false);
    expect(nameIsBlocked("Katherine Styles")).toBe(false);
    expect(nameIsBlocked("Adom Mart")).toBe(false);
  });
});

describe("contrast fixing — never an unreadable pair", () => {
  it("swaps unreadable text on the surface for the nearest passing fallback", () => {
    const broken = palette({ surface: "#F8F6F0", text: "#FAF8F2" });
    const fixed = fixPaletteContrast(broken);
    expect(fixed.text).toBe("#111827");
    expect(contrastRatio(fixed.text, fixed.surface)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("prefers white text when the surface is dark and the supplied text is also dark", () => {
    const broken = palette({ surface: "#111111", text: "#1A1A1A" });
    const fixed = fixPaletteContrast(broken);
    expect(fixed.text).toBe("#FFFFFF");
    expect(contrastRatio(fixed.text, fixed.surface)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("keeps text that already reads well", () => {
    const good = palette({ surface: "#FFFFFF", text: "#154273" });
    expect(fixPaletteContrast(good).text).toBe("#154273");
  });

  it("computes the white-on-primary header check the palettes are judged with", () => {
    // White on a light gold is unreadable; the on-primary helper must say so
    // and offer the dark fallback for anything drawn on that primary.
    expect(contrastRatio("#FFFFFF", "#C9A96A")).toBeLessThan(4.5);
    expect(readableTextOn("#C9A96A")).toBe("#111827");
    expect(readableTextOn("#0A1F44")).toBe("#FFFFFF");
  });

  it("palettes returned by a suggest are all contrast-fixed", async () => {
    const output = makeOutput(
      [
        "Adom Mart",
        "Adepa Styles",
        "Kof Corner",
        "Nhyira Press",
        "Oseikrom Deals",
      ],
      [
        palette({ label: "Broken", surface: "#F8F6F0", text: "#F8F6F0" }),
        palette({ label: "OK" }),
        palette({ label: "Dark", surface: "#111111", text: "#111111" }),
      ],
    );
    const { provider } = fakeProvider([output]);

    const suggestion = await suggestBrandKit(BASE_INPUT, provider);

    for (const p of suggestion.palettes) {
      expect(contrastRatio(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(suggestion.palettes[0]!.text).toBe("#111827");
    expect(suggestion.palettes[2]!.text).toBe("#FFFFFF");
  });
});

describe("small helpers", () => {
  it("slugs a name to lowercase letters and digits only", () => {
    expect(brandSlug("Adom & Sons")).toBe("adomsons");
    expect(brandSlug("Nana-Nhyira 24")).toBe("nananhyira24");
    expect(brandSlug("Charley's Kitchen")).toBe("charleyskitchen");
  });

  it("offers the two hand-check domains", () => {
    expect(domainCandidates("Adom Mart")).toEqual([
      "adommart.com",
      "adommart.com.gh",
    ]);
  });

  it("builds hand-check links without any network call", () => {
    const links = checkLinks("Adom Mart");
    expect(links.instagram).toContain("instagram.com/adommart");
    expect(links.tiktok).toContain("tiktok.com/@adommart");
    expect(links.whois).toContain("whois.com/whois/adommart.com");
  });

  it("uses every theme id from the shared registry in the prompt", () => {
    const messages = brandKitMessages(brandKitInputSchema.parse(BASE_INPUT));
    const text = messages.map((m) => m.content).join("\n");
    for (const id of THEME_IDS) expect(text).toContain(id);
  });
});

describe("the hourly suggest budget", () => {
  it("allows ten suggests per owner per hour and refuses the eleventh", () => {
    resetRateLimitForTests();
    try {
      for (let i = 0; i < BRAND_KIT_SUGGESTS_PER_HOUR; i += 1) {
        expect(() => assertBrandKitSuggestRateLimit("owner-1")).not.toThrow();
      }
      expect(BRAND_KIT_SUGGESTS_PER_HOUR).toBe(10);
      expect(() => assertBrandKitSuggestRateLimit("owner-1")).toThrow(
        RateLimitError,
      );
      // A different owner has their own bucket.
      expect(() => assertBrandKitSuggestRateLimit("owner-2")).not.toThrow();
    } finally {
      resetRateLimitForTests();
    }
  });
});
