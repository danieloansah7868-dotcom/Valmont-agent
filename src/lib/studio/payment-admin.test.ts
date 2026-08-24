import { afterEach, describe, expect, it, vi } from "vitest";
import { canManagePaymentSettings } from "./payment-admin";

const danny = {
  id: "1",
  login: "danieloansah7868-dotcom",
  name: "Danny Pounds",
};

afterEach(() => vi.unstubAllEnvs());

describe("payment settings managers", () => {
  it("defaults to the agency owner", () => {
    expect(canManagePaymentSettings(danny)).toBe(true);
    expect(
      canManagePaymentSettings({ ...danny, login: "another-github-user" }),
    ).toBe(false);
  });

  it("accepts the configured agency manager list without case sensitivity", () => {
    vi.stubEnv(
      "PAYMENT_SETTINGS_ADMIN_LOGINS",
      "danieloansah7868-dotcom, Agency-Finance",
    );
    expect(
      canManagePaymentSettings({ ...danny, login: "agency-finance" }),
    ).toBe(true);
  });
});
