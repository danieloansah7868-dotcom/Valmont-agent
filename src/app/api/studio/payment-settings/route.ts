import { NextResponse, type NextRequest } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { readBoundedJson } from "@/lib/bounded-json";
import { safeApiError } from "@/lib/api";
import { assertCsrf } from "@/lib/security";
import { assertCanManagePaymentSettings } from "@/lib/studio/payment-admin";
import {
  publicPaymentSettings,
  updatePaymentSettings,
  type PaymentSettingsUpdate,
} from "@/lib/studio/payment-settings";

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    assertCanManagePaymentSettings(user);
    return NextResponse.json(publicPaymentSettings());
  } catch (error) {
    return safeApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireApiSessionUser();
    assertCanManagePaymentSettings(user);
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
