import {
  CustomerEmailConfigurationError,
  CustomerEmailDeliveryError,
} from "@/lib/api-errors";
import {
  getResendConfigState,
  getValidatedResendConfig,
} from "@/lib/resend-config";

export { CustomerEmailDeliveryError, CustomerEmailConfigurationError };

export function customerEmailDeliveryConfigured(): boolean {
  return getResendConfigState() === "configured";
}

export function assertCustomerEmailDeliveryReady(): void {
  const state = getResendConfigState();
  if (state === "invalid") {
    throw new CustomerEmailConfigurationError();
  }
  if (process.env.NODE_ENV === "production" && state === "not_configured") {
    throw new CustomerEmailConfigurationError();
  }
}

interface CustomerEmailInput {
  to: string;
  name: string;
  subject: string;
  text: string;
  html: string;
  developmentLink: string;
}

interface CustomerEmailResult {
  delivered: boolean;
  /** Returned only when email is intentionally local and no provider is set. */
  developmentLink?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Provider-independent delivery boundary for customer authentication emails.
 * Resend is supported out of the box when RESEND_API_KEY and
 * NOTIFY_EMAIL_FROM are configured, while local development gets a safe,
 * explicitly marked link instead of silently losing the message.
 */
export async function sendCustomerEmail(
  input: CustomerEmailInput,
): Promise<CustomerEmailResult> {
  const state = getResendConfigState();
  if (state === "invalid") {
    throw new CustomerEmailConfigurationError();
  }

  const validated = getValidatedResendConfig();
  if (validated) {
    const { apiKey, from } = validated;
    const controller = new AbortController();
    const timeoutMs = 10_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const startTimeout = () => {
      timeout = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore abort errors
        }
      }, timeoutMs);
    };

    const clear = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    try {
      startTimeout();
      let response: Response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [input.to],
            subject: input.subject,
            text: input.text,
            html: input.html,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        // Normalize timeout/abort and network failures to delivery error.
        // Do not leak provider details.
        if (error instanceof CustomerEmailConfigurationError) throw error;
        throw new CustomerEmailDeliveryError();
      } finally {
        clear();
      }

      if (!response.ok) {
        throw new CustomerEmailDeliveryError();
      }
      return { delivered: true };
    } catch (error) {
      clear();
      if (error instanceof CustomerEmailConfigurationError) {
        throw error;
      }
      if (error instanceof CustomerEmailDeliveryError) {
        throw error;
      }
      // Any other error (including AbortError) becomes delivery failure
      throw new CustomerEmailDeliveryError();
    } finally {
      clear();
    }
  }

  // Never return authentication links in production. A production deployment
  // must configure a provider before these flows can be customer-facing.
  assertCustomerEmailDeliveryReady();

  // Keep a useful local path without logging or persisting the raw token.
  return {
    delivered: false,
    developmentLink: input.developmentLink,
  };
}

export function customerEmailHtml(
  heading: string,
  name: string,
  copy: string,
  actionLabel: string,
  actionUrl: string,
): string {
  return `<!doctype html>
<html lang="en">
  <body style="font-family:Arial,sans-serif;color:#17233d;line-height:1.5">
    <h1>${escapeHtml(heading)}</h1>
    <p>Hello ${escapeHtml(name)},</p>
    <p>${escapeHtml(copy)}</p>
    <p><a href="${escapeHtml(actionUrl)}">${escapeHtml(actionLabel)}</a></p>
    <p style="color:#667085;font-size:12px">If you did not request this, you can ignore this email.</p>
  </body>
</html>`;
}
