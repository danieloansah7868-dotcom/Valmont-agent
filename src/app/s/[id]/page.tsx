import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Storefront } from "@/components/studio/storefront";
import { publicGetDraft } from "@/lib/studio/draft-public";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const draft = await publicGetDraft(id);
  if (!draft) {
    return { title: "Shop not found" };
  }
  const title = draft.brief.businessName;
  const description =
    draft.brief.tagline?.trim() ||
    draft.brief.description?.trim() ||
    `${title} on Valmont`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function PublicShopPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const draft = await publicGetDraft(id);
  if (!draft) notFound();
  return <Storefront brief={draft.brief} draftId={draft.id} variant="public" />;
}
