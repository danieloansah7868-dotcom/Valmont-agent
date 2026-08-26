import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioDrafts } from "@/db/schema";
import { getStudioSqliteDb, normalizeBrief } from "./draft-store";
import type { SiteBriefV1, StudioDraft } from "./site-brief/schema";

/**
 * A brief safe to send to an anonymous shopper. Secrets — the Valmont Pay API
 * key above all — are stripped, and the brief is normalized so a pre-Phase-3
 * draft still exposes an `items`/`payments` shape.
 *
 * Checkout is public and remains available to guests. A signed-in customer may
 * be attached by the checkout endpoint after its session is verified, but these
 * readers remain deliberately owner-agnostic. Security rests on the draft id
 * being an unguessable UUID and on the server re-pricing every basket against
 * this catalogue, never trusting a client-sent price.
 */
export type PublicBrief = SiteBriefV1;

function stripSecrets(brief: SiteBriefV1): PublicBrief {
  const normalized = normalizeBrief(brief);
  return {
    ...normalized,
    payments: {
      ...normalized.payments,
      valmontPay: {
        merchantId: normalized.payments.valmontPay.merchantId,
        provisioned: normalized.payments.valmontPay.provisioned,
        // apiKey is intentionally never included in a public brief.
      },
    },
  };
}

interface DraftRow {
  id: string;
  owner_id: string;
  brief_json: string;
}

/**
 * Reads a draft by id for public (unauthenticated) consumption, with secrets
 * removed. Returns null when the draft does not exist.
 */
export async function publicGetDraft(
  draftId: string,
): Promise<{ id: string; ownerId: string; brief: PublicBrief } | null> {
  if (process.env.DATABASE_URL) {
    const [row] = await getDatabase()
      .select({
        id: studioDrafts.id,
        ownerId: studioDrafts.ownerId,
        brief: studioDrafts.brief,
      })
      .from(studioDrafts)
      .where(eq(studioDrafts.id, draftId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      brief: stripSecrets(row.brief as SiteBriefV1),
    };
  }

  const row = getStudioSqliteDb()
    .prepare("SELECT id, owner_id, brief_json FROM studio_drafts WHERE id = ?")
    .get(draftId) as unknown as DraftRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    brief: stripSecrets(JSON.parse(row.brief_json) as SiteBriefV1),
  };
}

/**
 * The owner id for a draft, or null. Used by the checkout endpoint to attribute
 * a new order to the shop's owner without exposing the rest of the draft.
 */
export async function publicGetDraftOwnerId(
  draftId: string,
): Promise<string | null> {
  const draft = await publicGetDraft(draftId);
  return draft?.ownerId ?? null;
}

/**
 * The full internal draft (secrets intact) for server-side pricing. Never sent
 * to a browser — only used inside the checkout endpoint to read the true
 * catalogue and Valmont Pay credentials.
 */
export async function internalGetDraftForCheckout(
  draftId: string,
): Promise<Pick<StudioDraft, "id" | "ownerId" | "brief"> | null> {
  if (process.env.DATABASE_URL) {
    const [row] = await getDatabase()
      .select({
        id: studioDrafts.id,
        ownerId: studioDrafts.ownerId,
        brief: studioDrafts.brief,
      })
      .from(studioDrafts)
      .where(eq(studioDrafts.id, draftId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      brief: normalizeBrief(row.brief as SiteBriefV1),
    };
  }

  const row = getStudioSqliteDb()
    .prepare("SELECT id, owner_id, brief_json FROM studio_drafts WHERE id = ?")
    .get(draftId) as unknown as DraftRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    brief: normalizeBrief(JSON.parse(row.brief_json) as SiteBriefV1),
  };
}
