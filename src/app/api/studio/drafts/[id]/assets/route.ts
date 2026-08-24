import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { readBoundedJson } from "@/lib/bounded-json";
// Images are sent as base64 data URLs which grow ~33% over raw bytes,
// so allow a larger cap for the upload endpoint than the text-only PATCH.
const ASSET_BODY_LIMIT_BYTES = 2_500_000; // ~2.5 MB
import {
  checkAssetBudget,
  validateUploadedImage,
} from "@/lib/studio/asset-validation";
import type { StoredImage } from "@/lib/studio/assets";

/**
 * POST /api/studio/drafts/[id]/assets
 * Body: { kind: "logo"|"photo", image: { dataUrl, fileName, mime, width, height }, expectedRevision }
 *
 * Validates the upload, applies it to the brief.assets, then saves the whole
 * draft through the same optimistic-concurrency path the wizard text fields
 * use. Returns the updated StudioDraft.
 *
 * DELETE /api/studio/drafts/[id]/assets?target=logo  OR  ?photoIndex=N
 * Removes the named asset and saves.
 */

const uploadBodySchema = z.object({
  kind: z.enum(["logo", "photo"]),
  expectedRevision: z.number().int().min(1),
  image: z.object({
    dataUrl: z.string().max(1_600_000),
    fileName: z.string().max(200),
    mime: z.string().max(50),
    width: z.number().min(1).max(4000),
    height: z.number().min(1).max(4000),
  }),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const user = await requireApiSessionUser();
    assertOwnerRateLimit("studio-mutation", canonicalUserId(user), 30);
    const store = getStudioDraftStore();

    const existing = await store.get(user, id);
    if (!existing) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const body = (await readBoundedJson(
      request as unknown as Request,
      ASSET_BODY_LIMIT_BYTES,
    )) as unknown;
    const parsed = uploadBodySchema.parse(body);
    const image: StoredImage = validateUploadedImage({
      kind: parsed.kind,
      ...parsed.image,
    });

    const currentAssets = existing.brief.assets ?? { logo: null, photos: [] };
    checkAssetBudget(currentAssets, { kind: parsed.kind, size: image.size });

    const nextAssets =
      parsed.kind === "logo"
        ? { ...currentAssets, logo: image }
        : { ...currentAssets, photos: [...currentAssets.photos, image] };

    const nextBrief = siteBriefSchemaV1.parse({
      ...existing.brief,
      assets: nextAssets,
    });

    const updated = await store.update(
      user,
      id,
      nextBrief,
      parsed.expectedRevision,
    );
    return NextResponse.json(updated);
  } catch (e) {
    return safeApiError(e);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const user = await requireApiSessionUser();
    assertOwnerRateLimit("studio-mutation", canonicalUserId(user), 30);
    const store = getStudioDraftStore();

    const existing = await store.get(user, id);
    if (!existing) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("target");
    const photoIndexParam = url.searchParams.get("photoIndex");
    const expectedRev = Number(url.searchParams.get("expectedRevision"));
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      return NextResponse.json(
        { error: "expectedRevision is required" },
        { status: 400 },
      );
    }

    const current = existing.brief.assets ?? { logo: null, photos: [] };
    let nextAssets;
    if (target === "logo") {
      nextAssets = { ...current, logo: null };
    } else if (target === "photo" && photoIndexParam !== null) {
      const idx = Number(photoIndexParam);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.photos.length) {
        return NextResponse.json(
          { error: "Photo index out of range" },
          { status: 400 },
        );
      }
      nextAssets = {
        ...current,
        photos: current.photos.filter((_, i) => i !== idx),
      };
    } else {
      return NextResponse.json(
        { error: "Specify target=logo or target=photo&photoIndex=N" },
        { status: 400 },
      );
    }

    const nextBrief = siteBriefSchemaV1.parse({
      ...existing.brief,
      assets: nextAssets,
    });
    const updated = await store.update(user, id, nextBrief, expectedRev);
    return NextResponse.json(updated);
  } catch (e) {
    return safeApiError(e);
  }
}
