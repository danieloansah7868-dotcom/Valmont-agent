import { NextResponse, type NextRequest } from "next/server";
import { assertCsrf } from "@/lib/security";

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.delete("valmont_session");
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 403 });
  }
}
