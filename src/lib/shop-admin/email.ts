import {
  customerEmailDeliveryConfigured,
  customerEmailHtml,
  sendCustomerEmail,
} from "@/lib/customer-email";
import { getResendConfigState } from "@/lib/resend-config";
import {
  CustomerEmailConfigurationError,
  CustomerEmailDeliveryError,
} from "@/lib/api-errors";

/**
 * Shop-admin emails (invite and password reset) go through the same Resend
 * boundary as customer emails — `sendCustomerEmail` is a generic transport
 * despite its name, and re-implementing it would only duplicate its
 * timeout/leak handling.
 *
 * The one deliberate difference from the customer flows is what happens when
 * no provider is configured. A customer flow fails closed in production. A
 * shop invite instead hands the *agency user* (who is signed in to Studio and
 * already trusted with the whole website) the one-time link so they can send
 * it to the owner on WhatsApp. That is why {@link deliverShopAdminLink}
 * returns the link only when email is unconfigured, and never when it is.
 */

export type ShopAdminLinkKind = "invite" | "reset";

export interface ShopAdminLinkDelivery {
  /** True when the email left through the configured provider. */
  delivered: boolean;
  /**
   * The one-time link — present only when email is unconfigured so the agency
   * user can pass it on by hand. Never set when a provider is configured, no
   * matter what happened to the send.
   */
  link?: string;
}

export function shopAdminEmailConfigured(): boolean {
  return customerEmailDeliveryConfigured();
}

function copyFor(kind: ShopAdminLinkKind, shopName: string) {
  if (kind === "invite") {
    return {
      subject: `You have been given a login for ${shopName}`,
      heading: `Your ${shopName} login`,
      intro: `You have been invited to manage ${shopName}. Use the link below to choose your password. It works once and expires in 24 hours.`,
      action: "Set your password",
    };
  }
  return {
    subject: `Reset your ${shopName} password`,
    heading: `Reset your ${shopName} password`,
    intro: `We received a request to reset the password for your ${shopName} login. The link works once and expires in one hour.`,
    action: "Choose a new password",
  };
}

/**
 * Sends the link by email when a provider is configured, or returns it for
 * hand delivery when none is. Callers on the *admin* side (forgot-password)
 * must never surface the returned link to the browser; only the Studio-side
 * routes, which answer the agency user, may.
 */
export async function deliverShopAdminLink(input: {
  kind: ShopAdminLinkKind;
  to: string;
  name: string;
  shopName: string;
  link: string;
}): Promise<ShopAdminLinkDelivery> {
  const copy = copyFor(input.kind, input.shopName);
  const state = getResendConfigState();
  // Half-configured (one of the two variables set, or malformed) is an
  // operator mistake, not "no email": fail closed with the same 503 the
  // customer flows raise, rather than silently falling back to a hand-off.
  if (state === "invalid") throw new CustomerEmailConfigurationError();
  if (state === "not_configured") {
    return { delivered: false, link: input.link };
  }
  const result = await sendCustomerEmail({
    to: input.to,
    name: input.name,
    subject: copy.subject,
    text: `${copy.intro}\n\n${input.link}`,
    html: customerEmailHtml(
      copy.heading,
      input.name,
      copy.intro,
      copy.action,
      input.link,
    ),
    developmentLink: input.link,
  });
  // With a provider configured `sendCustomerEmail` never returns a link; the
  // destructure makes that explicit so a future change cannot leak one here.
  return { delivered: result.delivered };
}

export { CustomerEmailDeliveryError as ShopAdminEmailDeliveryError };
