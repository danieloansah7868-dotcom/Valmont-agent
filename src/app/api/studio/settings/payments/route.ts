import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import {
  canManagePayments,
  isSecurePaymentApiUrl,
  paymentSettingsStatus,
  resolvePaymentConfig,
  writePaymentSettings,
} from "@/lib/studio/payment-settings";

/**
 * Studio payment settings API.
 *
 * GET returns only the browser-safe status (SET / NOT SET per field, current
 * mode, and whether the signed-in GitHub account may manage payments). The
 * saved Valmont Pay secrets themselves are never returned by any endpoint.
 *
 * PUT replaces settings. Only an approved payment-manager account may write;
 * everyone else gets a plain 403.
 */

const secretValue = z.union([z.string().max(1_000), z.null()]).optional();

const updateSchema = z.object({
  mode: z.enum(["test", "live"]),
  apiUrl: secretValue,
  apiKey: secretValue,
  webhookSecret: secretValue,
});

function forbidden() {
  return NextResponse.json(
    {
      error:
        "Only the payment manager account can change payment settings. " +
        "Sign in with the GitHub account that manages Valmont Pay.",
    },
    { status: 403 },
  );
}

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    return NextResponse.json(await paymentSettingsStatus(user));
  } catch (error) {
    return safeApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertCsrf(request);
    const user = await requireApiSessionUser();
    assertOwnerRateLimit("studio-payment-settings", user.id, 20);
    if (!canManagePayments(user)) return forbidden();

    const body = (await readBoundedJson(
      request as unknown as Request,
      8_000,
    )) as unknown;
    const parsed = updateSchema.parse(body);

    if (parsed.apiUrl !== undefined && parsed.apiUrl !== null) {
      const trimmed = parsed.apiUrl.trim();
      if (trimmed) {
        let url: URL;
        try {
          url = new URL(trimmed);
        } catch {
          return NextResponse.json(
            {
              error:
                "The Valmont Pay website address does not look right. " +
                "It should start with https:// — paste exactly what Valmont Pay gave you.",
            },
            { status: 400 },
          );
        }
        if (!isSecurePaymentApiUrl(url.toString())) {
          return NextResponse.json(
            {
              error:
                "The Valmont Pay website address must be a valid https:// address. " +
                "Real payment keys must never be sent over an insecure connection.",
            },
            { status: 400 },
          );
        }
      }
    }

    await writePaymentSettings({
      mode: parsed.mode,
      apiUrl: parsed.apiUrl,
      apiKey: parsed.apiKey,
      webhookSecret: parsed.webhookSecret,
      updatedBy: user.login,
    });

    // Safety rule from the Phase 5 brief: Live requires both keys present.
    // The mode is saved either way, but checkout only goes truly live when
    // both keys exist — and the response says so in plain words.
    const config = await resolvePaymentConfig();
    const status = await paymentSettingsStatus(user);
    if (parsed.mode === "live" && !config.keysPresent) {
      return NextResponse.json({
        ...status,
        warning:
          "Live mode is saved, but real payments cannot start until BOTH " +
          "a valid https:// Valmont Pay website address and the secret key are " +
          "set. Checkout stays in test mode until then.",
      });
    }

    return NextResponse.json(status);
  } catch (error) {
    return safeApiError(error);
  }
}
