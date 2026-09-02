import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import {
  getDomainStore,
  newVerificationToken,
  normalizeHostname,
  verificationRecordName,
  verificationRecordValue,
  type DomainRow,
} from "@/lib/studio/domains";
import { checkDomain } from "@/lib/studio/domain-verification";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { canonicalUserId } from "@/lib/user-identity";
import { readBoundedJson, DRAFT_BODY_LIMIT_BYTES } from "@/lib/bounded-json";
import { BadRequestError, ConflictError } from "@/lib/api-errors";

/**
 * What the owner sees: the hostname, its status and the two DNS records to
 * publish. The verification token is shown only to the draft's owner (this
 * route is owner-scoped) and is useless to anyone else — it proves control
 * of the zone, not identity.
 */
function present(domain: DomainRow, detail?: string) {
  return {
    hostname: domain.hostname,
    status: domain.status,
    verifiedAt: domain.verified_at,
    lastCheckedAt: domain.last_checked_at,
    records: {
      txt: {
        name: verificationRecordName(domain.hostname),
        value: verificationRecordValue(domain.verification_token ?? ""),
      },
      cname: {
        name: domain.hostname,
        target: process.env.STUDIO_PLATFORM_HOST?.trim() || null,
      },
    },
    ...(detail ? { detail } : {}),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiSessionUser();
    const { id } = await params;

    // Auth & Draft ownership
    const draft = await getStudioDraftStore().get(user, id);
    if (!draft)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    const domainStore = getDomainStore();
    const domain = await domainStore.getDomain(id);

    if (!domain) return NextResponse.json(null);
    return NextResponse.json(present(domain));
  } catch (err) {
    return safeApiError(err);
  }
}

const postSchema = z.object({
  hostname: z.string().min(1).max(253),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiSessionUser();
    const { id } = await params;

    assertCsrf(request);
    assertOwnerRateLimit("domain_write", canonicalUserId(user));

    const draft = await getStudioDraftStore().get(user, id);
    if (!draft)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await readBoundedJson(request, DRAFT_BODY_LIMIT_BYTES);
    const { hostname: rawHostname } = postSchema.parse(body);

    const hostname = normalizeHostname(rawHostname);
    if (!hostname) {
      throw new BadRequestError(
        "Enter a domain name such as example.com or shop.example.com.",
      );
    }

    // One hostname belongs to at most one draft.
    const domainStore = getDomainStore();
    const existingByHostname = await domainStore.getDomainByHostname(hostname);
    if (existingByHostname && existingByHostname.draft_id !== id) {
      throw new ConflictError("Domain is already in use by another website.");
    }

    // Keep the existing token when the owner re-checks the same hostname so a
    // TXT record already published keeps working; mint a fresh one when the
    // hostname changes so a proof for the old name cannot carry over.
    const current = await domainStore.getDomain(id);
    const token =
      current && current.hostname === hostname && current.verification_token
        ? current.verification_token
        : newVerificationToken();

    const check = await checkDomain({
      hostname,
      token,
      platformHost: process.env.STUDIO_PLATFORM_HOST,
    });
    const now = new Date().toISOString();

    await domainStore.setDomain({
      draftId: id,
      ownerId: canonicalUserId(user),
      hostname,
      status: check.status,
      verificationToken: token,
      verifiedAt: check.ownershipProven ? (current?.verified_at ?? now) : null,
      lastCheckedAt: now,
    });

    const saved = await domainStore.getDomain(id);
    if (!saved) throw new Error("Domain row vanished after save");
    return NextResponse.json(present(saved, check.detail));
  } catch (err) {
    return safeApiError(err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiSessionUser();
    const { id } = await params;

    assertCsrf(request);
    assertOwnerRateLimit("domain_write", canonicalUserId(user));

    const draft = await getStudioDraftStore().get(user, id);
    if (!draft)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    const domainStore = getDomainStore();
    await domainStore.deleteDomain(id);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return safeApiError(err);
  }
}
