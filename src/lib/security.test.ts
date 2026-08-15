import { describe, expect, it } from "vitest";
import {
  containsLikelySecret,
  decryptSessionValue,
  encryptSessionValue,
  redactSecrets,
} from "@/lib/security";

describe("secret security", () => {
  it("redacts common credentials without removing ordinary content", () => {
    const input = [
      "Authorization docs",
      "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
      "api_key: sk-proj-abcdefghijklmnopqrstuv",
      "DATABASE_URL=postgresql://admin:supersecret@db.internal/app",
      "password=hunter2",
    ].join("\n");
    const output = redactSecrets(input);
    expect(output).toContain("Authorization docs");
    expect(output).not.toContain("supersecret");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(output).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
    expect(output).toContain("[REDACTED");
  });

  it("preserves explicit documentation placeholders", () => {
    expect(redactSecrets("MODEL_API_KEY=replace-me")).toBe(
      "MODEL_API_KEY=replace-me",
    );
    expect(redactSecrets("MODEL_API_KEY=actual-secret-value")).toBe(
      "MODEL_API_KEY=[REDACTED]",
    );
  });

  it("blocks high-confidence generated secrets before commit", () => {
    expect(
      containsLikelySecret("const key = 'sk-proj-abcdefghijklmnopqrstuv';"),
    ).toBe(true);
    expect(
      containsLikelySecret("const token = process.env.GITHUB_TOKEN;"),
    ).toBe(false);
  });

  it("encrypts OAuth session data with authenticated encryption", () => {
    const secret = "a-development-secret-with-at-least-32-bytes";
    const envelope = encryptSessionValue("gho_not-a-real-token", secret);
    expect(envelope).not.toContain("gho_not-a-real-token");
    expect(decryptSessionValue(envelope, secret)).toBe("gho_not-a-real-token");
    expect(() =>
      decryptSessionValue(`${envelope.slice(0, -2)}aa`, secret),
    ).toThrow();
  });
});
