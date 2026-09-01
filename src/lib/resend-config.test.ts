import { describe, expect, it } from "vitest";
import {
  getResendConfigState,
  isValidEmailAddress,
  isValidSender,
} from "@/lib/resend-config";

describe("resend-config validation", () => {
  it("validates plain email addresses", () => {
    expect(isValidEmailAddress("noreply@example.com")).toBe(true);
    expect(isValidEmailAddress("user+tag@example.co.uk")).toBe(true);
    expect(isValidEmailAddress("invalid")).toBe(false);
    expect(isValidEmailAddress("invalid@")).toBe(false);
    expect(isValidEmailAddress("@example.com")).toBe(false);
    expect(isValidEmailAddress("a@b")).toBe(false);
    expect(isValidEmailAddress("")).toBe(false);
    expect(isValidEmailAddress("noreply@example.com\r\nBcc: x")).toBe(false);
    expect(isValidEmailAddress("noreply@example.com with space")).toBe(false);
  });

  it("validates sender display-name format", () => {
    expect(isValidSender("noreply@example.com")).toBe(true);
    expect(isValidSender("Valmont <noreply@example.com>")).toBe(true);
    expect(isValidSender("  Valmont Studio  <noreply@example.com>  ")).toBe(
      true,
    );
    expect(isValidSender("invalid")).toBe(false);
    expect(isValidSender("Valmont <invalid>")).toBe(false);
    expect(isValidSender("Valmont <noreply@example.com>\r\nBcc: x")).toBe(
      false,
    );
    expect(isValidSender("")).toBe(false);
    expect(isValidSender("   ")).toBe(false);
    expect(isValidSender("noreply@example.com\n")).toBe(false);
  });

  it("detects not_configured, configured, invalid states", () => {
    expect(getResendConfigState({})).toBe("not_configured");
    expect(
      getResendConfigState({
        RESEND_API_KEY: "re_12345678",
        NOTIFY_EMAIL_FROM: "noreply@example.com",
      }),
    ).toBe("configured");
    expect(
      getResendConfigState({
        RESEND_API_KEY: "re_12345678",
      }),
    ).toBe("invalid");
    expect(
      getResendConfigState({
        NOTIFY_EMAIL_FROM: "noreply@example.com",
      }),
    ).toBe("invalid");
    expect(
      getResendConfigState({
        RESEND_API_KEY: "   ",
        NOTIFY_EMAIL_FROM: "noreply@example.com",
      }),
    ).toBe("invalid");
    expect(
      getResendConfigState({
        RESEND_API_KEY: "re_12345678",
        NOTIFY_EMAIL_FROM: "not-an-email",
      }),
    ).toBe("invalid");
    expect(
      getResendConfigState({
        RESEND_API_KEY: "re_12345678",
        NOTIFY_EMAIL_FROM: "noreply@example.com\r\nInjection",
      }),
    ).toBe("invalid");
  });
});
