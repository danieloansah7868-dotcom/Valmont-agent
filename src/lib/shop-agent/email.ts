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

export type ShopAgentLinkKind = "invite" | "reset";

export interface ShopAgentLinkDelivery {
  delivered: boolean;
  link?: string;
}

export function shopAgentEmailConfigured(): boolean {
  return customerEmailDeliveryConfigured();
}

function copyFor(kind: ShopAgentLinkKind, shopName: string) {
  if (kind === "invite") {
    return {
      subject: `You have been given an agent login for ${shopName}`,
      heading: `Your ${shopName} agent login`,
      intro: `You have been added as an agent of ${shopName}. Use the link below to choose your password. It works once and expires in 24 hours.`,
      action: "Set your password",
    };
  }
  return {
    subject: `Reset your ${shopName} agent password`,
    heading: `Reset your ${shopName} agent password`,
    intro: `We received a request to reset the password for your ${shopName} agent login. The link works once and expires in one hour.`,
    action: "Choose a new password",
  };
}

export async function deliverShopAgentLink(input: {
  kind: ShopAgentLinkKind;
  to: string;
  name: string;
  shopName: string;
  link: string;
}): Promise<ShopAgentLinkDelivery> {
  const copy = copyFor(input.kind, input.shopName);
  const state = getResendConfigState();
  if (state === "invalid") throw new CustomerEmailConfigurationError();
  if (state === "not_configured") return { delivered: false, link: input.link };
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
  return { delivered: result.delivered };
}

export { CustomerEmailDeliveryError as ShopAgentEmailDeliveryError };
