import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getPaymentConfiguration } from "./payment-settings";
import {
  buildPublicUrl,
  type CreatePaymentLinkRequest,
  type CreatePaymentLinkResult,
} from "./valmont-pay";

export function isLiveConfigured(): boolean {
  return getPaymentConfiguration().liveActive;
}

export function paymentUrlFor(accessCode: string): string {
  const config = getPaymentConfiguration();
  if (config.liveActive)
    return buildPublicUrl(config.apiUrl!, "pay", { access_code: accessCode });
  return `/pay/${accessCode}`;
}

export async function createPaymentLink(
  req: CreatePaymentLinkRequest,
): Promise<CreatePaymentLinkResult> {
  const config = getPaymentConfiguration();
  if (!config.liveActive)
    return { paymentLink: `/pay/${req.accessCode}`, live: false };
  const response = await fetch(buildPublicUrl(config.apiUrl!, "links"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey!}`,
    },
    body: JSON.stringify({
      amount: Math.round(req.amount * 100),
      currency: req.currency,
      reference: req.reference,
      description: req.description,
      access_code: req.accessCode,
      customer: {
        name: req.customerName,
        email: req.customerEmail,
        phone: req.customerPhone,
      },
      callback_url: req.callbackUrl,
    }),
  });
  if (!response.ok)
    throw new Error("Valmont Pay could not create a payment link right now.");
  const data = (await response.json()) as { url?: string; link?: string };
  const paymentLink = data.url ?? data.link;
  if (!paymentLink) throw new Error("Valmont Pay returned no payment link.");
  return { paymentLink, live: true };
}

export function verifyWebhookSignature(
  body: string,
  signatureHeader: string | null,
): boolean {
  const config = getPaymentConfiguration();
  if (!config.liveActive) return true;
  if (!config.webhookSecret || !signatureHeader) return false;
  const supplied = signatureHeader
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  const expected = createHmac("sha256", config.webhookSecret)
    .update(body, "utf8")
    .digest("hex");
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(
    Buffer.from(supplied, "hex"),
    Buffer.from(expected, "hex"),
  );
}
