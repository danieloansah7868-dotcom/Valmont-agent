import { formatMoney } from "./valmont-pay";
import type { OrderRecord } from "./orders";
import type { SiteBriefV1 } from "./site-brief/schema";

export interface NotifyResult {
  email: "sent" | "skipped" | "failed";
  whatsapp: "sent" | "skipped" | "failed";
}

function linesSummary(order: OrderRecord): string {
  return order.lines
    .map((line) => `${line.name} × ${line.quantity}`)
    .join(", ");
}

export function orderAlertText(
  order: OrderRecord,
  brief: Pick<SiteBriefV1, "businessName">,
  viewUrl: string,
): string {
  const total = formatMoney(order.total, order.currency);
  return [
    `New order at ${brief.businessName}`,
    `Ref ${order.id.slice(0, 8)} · ${total}`,
    `${order.customerName} · ${order.customerPhone}`,
    linesSummary(order),
    order.customerAddress ? `Deliver to: ${order.customerAddress}` : null,
    order.merchantNote ? `Note: ${order.merchantNote}` : null,
    `View: ${viewUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function orderAlertHtml(
  order: OrderRecord,
  brief: Pick<SiteBriefV1, "businessName">,
  viewUrl: string,
): string {
  const total = formatMoney(order.total, order.currency);
  const rows = order.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.name)}</td><td>${line.quantity}</td><td>${escapeHtml(formatMoney(line.price * line.quantity, order.currency))}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#0A1F44">
  <h1>New order — ${escapeHtml(brief.businessName)}</h1>
  <p>Reference <strong>${escapeHtml(order.id.slice(0, 8))}</strong> · ${escapeHtml(total)}</p>
  <p>${escapeHtml(order.customerName)} · ${escapeHtml(order.customerPhone)}${
    order.customerEmail ? ` · ${escapeHtml(order.customerEmail)}` : ""
  }</p>
  ${
    order.customerAddress
      ? `<p>Deliver to: ${escapeHtml(order.customerAddress)}</p>`
      : ""
  }
  ${order.merchantNote ? `<p>Note: ${escapeHtml(order.merchantNote)}</p>` : ""}
  <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse">
    <thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
    <tbody>${rows}
      ${
        order.deliveryFee > 0
          ? `<tr><td colspan="2">Delivery</td><td>${escapeHtml(formatMoney(order.deliveryFee, order.currency))}</td></tr>`
          : ""
      }
      <tr><td colspan="2"><strong>Total</strong></td><td><strong>${escapeHtml(total)}</strong></td></tr>
    </tbody>
  </table>
  <p><a href="${escapeHtml(viewUrl)}">Open this order in Website Studio</a></p>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
) {
  const key = process.env.RESEND_API_KEY;
  const from =
    process.env.NOTIFY_EMAIL_FROM ?? "Valmont Studio <noreply@valmont.local>";
  if (!key) return "skipped" as const;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  return response.ok ? ("sent" as const) : ("failed" as const);
}

function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function sendWhatsAppOrSms(to: string, text: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (sid && token && from) {
    const body = new URLSearchParams({
      From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
      To: `whatsapp:+${digits(to)}`,
      Body: text,
    });
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );
    return response.ok ? ("sent" as const) : ("failed" as const);
  }

  const arkesel = process.env.ARKESEL_API_KEY;
  if (arkesel) {
    const response = await fetch("https://sms.arkesel.com/api/v2/sms/send", {
      method: "POST",
      headers: {
        "api-key": arkesel,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: process.env.ARKESEL_SENDER ?? "Valmont",
        message: text,
        recipients: [digits(to)],
      }),
    });
    return response.ok ? ("sent" as const) : ("failed" as const);
  }

  const termii = process.env.TERMII_API_KEY;
  if (termii) {
    const response = await fetch("https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: termii,
        to: digits(to),
        from: process.env.TERMII_SENDER ?? "Valmont",
        sms: text,
        type: "plain",
        channel: "generic",
      }),
    });
    return response.ok ? ("sent" as const) : ("failed" as const);
  }

  return "skipped" as const;
}

/**
 * Tells the merchant a new order arrived. Missing API keys are a no-op so
 * local test mode (and CI) never fail an order because mail/SMS is unset.
 */
export async function notifyMerchantNewOrder(input: {
  order: OrderRecord;
  brief: Pick<SiteBriefV1, "businessName" | "payments">;
  origin: string;
}): Promise<NotifyResult> {
  const viewUrl = `${input.origin.replace(/\/$/, "")}/studio/orders/${input.order.id}`;
  const text = orderAlertText(input.order, input.brief, viewUrl);
  const html = orderAlertHtml(input.order, input.brief, viewUrl);
  const subject = `New order ${input.order.id.slice(0, 8)} · ${input.brief.businessName}`;

  const emailTo = input.brief.payments.notifications.email;
  const phoneTo = input.brief.payments.notifications.whatsapp;

  const result: NotifyResult = { email: "skipped", whatsapp: "skipped" };
  try {
    if (emailTo) {
      result.email = await sendEmail(emailTo, subject, html, text);
    }
  } catch {
    result.email = "failed";
  }
  try {
    if (phoneTo) {
      result.whatsapp = await sendWhatsAppOrSms(phoneTo, text);
    }
  } catch {
    result.whatsapp = "failed";
  }
  return result;
}
