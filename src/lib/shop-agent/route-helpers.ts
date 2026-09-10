import { NotFoundError } from "@/lib/api-errors";
import { assertShopAgentsAllowed } from "./gate";
import { publicGetDraft, type PublicBrief } from "@/lib/studio/draft-public";

export interface GatedShopDraft {
  id: string;
  ownerId: string;
  brief: PublicBrief;
}

/** Missing drafts are not found; every existing non-eligible shop gets the package 403. */
export async function requireGatedShopDraft(
  id: string,
): Promise<GatedShopDraft> {
  const draft = await publicGetDraft(id);
  if (!draft) throw new NotFoundError();
  assertShopAgentsAllowed(draft.brief);
  return draft;
}
