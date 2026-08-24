import { ImageResponse } from "next/og";
import { publicGetDraft } from "@/lib/studio/draft-public";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const draft = await publicGetDraft(id);
  const name = draft?.brief.businessName ?? "Valmont shop";
  const tagline = draft?.brief.tagline ?? "Order online";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 80,
        background: "linear-gradient(155deg, #0A1F44 0%, #14446C 100%)",
        color: "#ECE9DE",
      }}
    >
      <div style={{ fontSize: 28, color: "#E8822B", fontWeight: 700 }}>
        Valmont
      </div>
      <div style={{ fontSize: 72, fontWeight: 800, marginTop: 16 }}>{name}</div>
      <div style={{ fontSize: 32, marginTop: 16, opacity: 0.85 }}>
        {tagline}
      </div>
    </div>,
    { ...size },
  );
}
