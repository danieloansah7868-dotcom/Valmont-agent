import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import dns from "node:dns/promises";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { getDomainStore, DomainStatus } from "@/lib/studio/domains";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { readBoundedJson, DRAFT_BODY_LIMIT_BYTES } from "@/lib/bounded-json";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiSessionUser();
    const { id } = await params;
    
    // Auth & Draft ownership
    const draft = await getStudioDraftStore().get(user, id);
    if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const domainStore = getDomainStore();
    const domain = await domainStore.getDomain(id);
    
    if (!domain) return NextResponse.json(null);
    return NextResponse.json({ hostname: domain.hostname, status: domain.status });
  } catch (err) {
    return safeApiError(err);
  }
}

const postSchema = z.object({
  hostname: z.string().min(1).max(253)
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiSessionUser();
    const { id } = await params;
    
    assertCsrf(request);
    assertOwnerRateLimit("domain_write", user.id);
    
    const draft = await getStudioDraftStore().get(user, id);
    if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await readBoundedJson(request, DRAFT_BODY_LIMIT_BYTES);
    const { hostname } = postSchema.parse(body);
    
    // Normalize hostname
    const normalizedHostname = hostname.trim().toLowerCase();
    
    // Ensure unique hostname
    const domainStore = getDomainStore();
    const existing = await domainStore.getDomainByHostname(normalizedHostname); 
    if (existing && existing.draft_id !== id) {
      return NextResponse.json({ error: "Domain is already in use by another draft" }, { status: 400 });
    }

    // Verify DNS
    let status: DomainStatus = "pending";
    const targetHost = process.env.STUDIO_PLATFORM_HOST;
    if (targetHost) {
      try {
        let isConnected = false;
        try {
          const cnames = await dns.resolveCname(normalizedHostname);
          if (cnames.some(c => c.toLowerCase() === targetHost.toLowerCase())) {
            isConnected = true;
          }
        } catch {
          // fallback to lookup if resolveCname fails (e.g., hosts file)
          const domainIp = await dns.lookup(normalizedHostname);
          const targetIp = await dns.lookup(targetHost);
          if (domainIp.address === targetIp.address) {
            isConnected = true;
          }
        }
        
        if (isConnected) {
          status = "active";
        } else {
          status = "error";
        }
      } catch {
        status = "error";
      }
    }

    await domainStore.setDomain(id, user.id, normalizedHostname, status);
    
    return NextResponse.json({ hostname: normalizedHostname, status });
  } catch (err) {
    return safeApiError(err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiSessionUser();
    const { id } = await params;
    
    assertCsrf(request);
    assertOwnerRateLimit("domain_write", user.id);
    
    const draft = await getStudioDraftStore().get(user, id);
    if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const domainStore = getDomainStore();
    await domainStore.deleteDomain(id);
    
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return safeApiError(err);
  }
}
