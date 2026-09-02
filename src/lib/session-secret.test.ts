import { describe, expect, it } from "vitest";
import {
  githubCredentialsConfigured,
  missingLiveRequirements,
  sessionSecretConfigured,
} from "@/lib/config";
import {
  decryptSessionValue,
  encryptSessionValue,
  WeakSessionSecretError,
} from "@/lib/security";
import {
  describeSessionSecretProblem,
  isStrongSessionSecret,
  SESSION_SECRET_MIN_LENGTH,
  sessionSecretProblem,
} from "@/lib/session-secret";

const strong = "9f2c1e0b7a6d4c3b8e5f1a2d3c4b5e6f7a8b9c0d1e2f3a4b";

describe("SESSION_SECRET strength policy", () => {
  it("accepts a long random value", () => {
    expect(sessionSecretProblem(strong)).toBeNull();
    expect(isStrongSessionSecret(strong)).toBe(true);
    expect(strong.length).toBeGreaterThanOrEqual(SESSION_SECRET_MIN_LENGTH);
  });

  it("reports a missing or blank value as missing", () => {
    expect(sessionSecretProblem(undefined)).toBe("missing");
    expect(sessionSecretProblem("")).toBe("missing");
    expect(sessionSecretProblem("   ")).toBe("missing");
  });

  it("rejects anything shorter than 32 characters", () => {
    expect(sessionSecretProblem("test-session-secret")).toBe("too_short");
    expect(sessionSecretProblem("a".repeat(31))).toBe("too_short");
  });

  it("rejects the placeholders that ship in example files even when long", () => {
    expect(sessionSecretProblem("replace-with-a-long-random-value")).toBe(
      "placeholder",
    );
    expect(
      sessionSecretProblem(
        "replace-with-a-long-random-value-of-at-least-32-bytes",
      ),
    ).toBe("placeholder");
    expect(sessionSecretProblem("REPLACE-WITH-A-LONG-RANDOM-VALUE")).toBe(
      "placeholder",
    );
    expect(sessionSecretProblem("change-this-before-production-please")).toBe(
      "placeholder",
    );
    expect(sessionSecretProblem("x".repeat(40))).toBe("placeholder");
    expect(sessionSecretProblem("0".repeat(64))).toBe("placeholder");
  });

  it("describes a problem without echoing the secret", () => {
    for (const problem of ["missing", "too_short", "placeholder"] as const) {
      const text = describeSessionSecretProblem(problem);
      expect(text).toContain("SESSION_SECRET");
      expect(text).not.toContain(strong);
    }
  });
});

describe("session encryption refuses weak secrets", () => {
  it("encrypts and decrypts under a strong secret", () => {
    const envelope = encryptSessionValue("gho_not-a-real-token", strong);
    expect(decryptSessionValue(envelope, strong)).toBe("gho_not-a-real-token");
  });

  it.each([
    ["missing", undefined],
    ["short", "test-session-secret"],
    ["placeholder", "replace-with-a-long-random-value"],
  ])("throws WeakSessionSecretError for a %s secret", (_label, secret) => {
    expect(() => encryptSessionValue("value", secret)).toThrow(
      WeakSessionSecretError,
    );
    expect(() => decryptSessionValue("a.b.c", secret)).toThrow(
      WeakSessionSecretError,
    );
  });
});

describe("runtime configuration treats a weak secret as missing", () => {
  const github = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };

  it("does not count GitHub as configured under a short or placeholder secret", () => {
    expect(sessionSecretConfigured({ SESSION_SECRET: "short" })).toBe(false);
    expect(
      githubCredentialsConfigured({ ...github, SESSION_SECRET: "short" }),
    ).toBe(false);
    expect(
      githubCredentialsConfigured({
        ...github,
        SESSION_SECRET: "replace-with-a-long-random-value",
      }),
    ).toBe(false);
    expect(
      githubCredentialsConfigured({ ...github, SESSION_SECRET: strong }),
    ).toBe(true);
  });

  it("lists SESSION_SECRET as still required when the value is weak", () => {
    expect(
      missingLiveRequirements({
        ...github,
        MODEL_API_KEY: "key",
        SESSION_SECRET: "replace-with-a-long-random-value",
      }),
    ).toEqual(["SESSION_SECRET"]);
    expect(
      missingLiveRequirements({
        ...github,
        MODEL_API_KEY: "key",
        SESSION_SECRET: strong,
      }),
    ).toEqual([]);
  });
});
