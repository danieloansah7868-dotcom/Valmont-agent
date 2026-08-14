import { describe, expect, it } from "vitest";
import {
  demoModeEnabled,
  missingLiveRequirements,
  runtimeReadiness,
} from "@/lib/config";

describe("runtime mode configuration", () => {
  it("defaults to live mode when ENABLE_DEMO_MODE is absent", () => {
    expect(demoModeEnabled({})).toBe(false);
    expect(runtimeReadiness({}).demoMode).toBe(false);
  });

  it("treats an explicit false as live mode", () => {
    for (const value of ["false", "FALSE", "0", "no", "off", ""]) {
      expect(demoModeEnabled({ ENABLE_DEMO_MODE: value })).toBe(false);
    }
  });

  it("enables demo mode only for explicit truthy values", () => {
    for (const value of ["true", "TRUE", " True ", "1", "yes", "on"]) {
      expect(demoModeEnabled({ ENABLE_DEMO_MODE: value })).toBe(true);
    }
  });

  it("reports live readiness from GitHub and model credentials", () => {
    expect(runtimeReadiness({}).liveReady).toBe(false);
    const ready = runtimeReadiness({
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      SESSION_SECRET: "a".repeat(32),
      MODEL_API_KEY: "key",
      DATABASE_URL: "postgres://localhost/valmont",
    });
    expect(ready).toMatchObject({
      demoMode: false,
      github: true,
      model: true,
      database: true,
      liveReady: true,
    });
  });

  it("lists exactly the variables still required for live mode", () => {
    expect(missingLiveRequirements({})).toEqual([
      "SESSION_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "MODEL_API_KEY",
    ]);
    expect(
      missingLiveRequirements({
        SESSION_SECRET: "a".repeat(32),
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        MODEL_API_KEY: "key",
      }),
    ).toEqual([]);
  });
});
