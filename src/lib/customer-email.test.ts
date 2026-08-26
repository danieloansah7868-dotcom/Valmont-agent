import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCustomerEmailDeliveryReady,
  sendCustomerEmail,
} from "@/lib/customer-email";

const email = {
  to: "ama@example.com",
  name: "Ama Mensah",
  subject: "Verify your account",
  text: "Verify your account",
  html: "<p>Verify your account</p>",
  developmentLink:
    "http://localhost:3000/api/customer/auth/verify?token=one-time",
};

describe("customer email delivery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fails closed in production when no provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("NOTIFY_EMAIL_FROM", undefined);

    expect(() => assertCustomerEmailDeliveryReady()).toThrow("not configured");
    await expect(sendCustomerEmail(email)).rejects.toThrow("not configured");
  });

  it("normalises provider failures to a delivery error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "resend-key");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "noreply@example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("provider down")),
    );

    await expect(sendCustomerEmail(email)).rejects.toThrow(
      "temporarily unavailable",
    );
  });

  it("returns a clearly local-only link when development has no provider", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("NOTIFY_EMAIL_FROM", undefined);

    await expect(sendCustomerEmail(email)).resolves.toEqual({
      delivered: false,
      developmentLink: email.developmentLink,
    });
  });
});
