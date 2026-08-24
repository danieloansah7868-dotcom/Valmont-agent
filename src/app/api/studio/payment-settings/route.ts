import { NextResponse, type NextRequest } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { readBoundedJson } from "@/lib/bounded-json";
import { safeApiError } from "@/lib/api";
import { assertCsrf } from "@/lib/security";
import {
  publicPaymentSettings,
  updatePaymentSettings,
  type PaymentSettingsUpdate,
} from "@/lib/studio/payment-settings";

export async function GET() {
  try {
    await requireApiSessionUser();
    return NextResponse.json(publicPaymentSettings());
  } catch (error) {
    return safeApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireApiSessionUser();
    assertCsrf(request);
    const body = (await readBoundedJson(
      request,
      25_000,
    )) as PaymentSettingsUpdate;
    updatePaymentSettings(body);
    return NextResponse.json(publicPaymentSettings());
  } catch (error) {
    return safeApiError(error);
  }
}
