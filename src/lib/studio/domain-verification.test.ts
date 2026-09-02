import { describe, expect, it } from "vitest";
import {
  checkDomain,
  DOMAIN_RECHECK_INTERVAL_MS,
  needsRecheck,
  type DomainResolver,
} from "./domain-verification";

const token = "0123456789abcdef0123456789abcdef";

function resolver(input: {
  txt?: Record<string, string[][]>;
  cname?: Record<string, string[]>;
}): DomainResolver {
  return {
    async resolveTxt(name) {
      const records = input.txt?.[name];
      if (!records) throw new Error("ENODATA");
      return records;
    },
    async resolveCname(name) {
      const records = input.cname?.[name];
      if (!records) throw new Error("ENODATA");
      return records;
    },
  };
}

describe("checkDomain", () => {
  it("activates only when the ownership TXT record AND the CNAME both match", async () => {
    const result = await checkDomain({
      hostname: "shop.example.com",
      token,
      platformHost: "valmont.test",
      resolver: resolver({
        txt: {
          "_valmont-verify.shop.example.com": [[`valmont-verify=${token}`]],
        },
        cname: { "shop.example.com": ["valmont.test."] },
      }),
    });
    expect(result).toMatchObject({
      status: "active",
      ownershipProven: true,
      cnameCorrect: true,
    });
  });

  it("refuses a CNAME that points at Valmont without an ownership proof (dangling-CNAME takeover)", async () => {
    const result = await checkDomain({
      hostname: "abandoned.example.com",
      token,
      platformHost: "valmont.test",
      resolver: resolver({
        cname: { "abandoned.example.com": ["valmont.test"] },
      }),
    });
    expect(result.status).toBe("error");
    expect(result.ownershipProven).toBe(false);
    expect(result.cnameCorrect).toBe(true);
    expect(result.detail).toMatch(/ownership TXT record was not found/i);
  });

  it("does not accept a TXT record minted for a different draft", async () => {
    const result = await checkDomain({
      hostname: "shop.example.com",
      token,
      platformHost: "valmont.test",
      resolver: resolver({
        txt: {
          "_valmont-verify.shop.example.com": [
            ["valmont-verify=ffffffffffffffffffffffffffffffff"],
          ],
        },
        cname: { "shop.example.com": ["valmont.test"] },
      }),
    });
    expect(result.status).toBe("error");
    expect(result.ownershipProven).toBe(false);
  });

  it("joins multi-string TXT records and ignores unrelated ones", async () => {
    const result = await checkDomain({
      hostname: "shop.example.com",
      token,
      platformHost: "valmont.test",
      resolver: resolver({
        txt: {
          "_valmont-verify.shop.example.com": [
            ["v=spf1 -all"],
            ["valmont-verify=", token],
          ],
        },
        cname: { "shop.example.com": ["VALMONT.TEST"] },
      }),
    });
    expect(result.status).toBe("active");
  });

  it("reports a proven domain whose CNAME is wrong as an error, never active", async () => {
    const result = await checkDomain({
      hostname: "shop.example.com",
      token,
      platformHost: "valmont.test",
      resolver: resolver({
        txt: {
          "_valmont-verify.shop.example.com": [[`valmont-verify=${token}`]],
        },
        cname: { "shop.example.com": ["other-host.example"] },
      }),
    });
    expect(result).toMatchObject({
      status: "error",
      ownershipProven: true,
      cnameCorrect: false,
    });
  });

  it("stays pending while neither record exists", async () => {
    const result = await checkDomain({
      hostname: "shop.example.com",
      token,
      platformHost: "valmont.test",
      resolver: resolver({}),
    });
    expect(result.status).toBe("pending");
  });

  it("never falls back to comparing IP addresses", async () => {
    // A resolver with no CNAME support at all: the old implementation would
    // have compared A records here and matched shared hosting by accident.
    const result = await checkDomain({
      hostname: "shared.example.com",
      token,
      platformHost: "valmont.test",
      resolver: {
        async resolveTxt() {
          return [[`valmont-verify=${token}`]];
        },
        async resolveCname() {
          throw new Error("ENODATA");
        },
      },
    });
    expect(result.status).toBe("error");
    expect(result.cnameCorrect).toBe(false);
  });

  it("cannot activate a domain when the platform host is not configured", async () => {
    const result = await checkDomain({
      hostname: "shop.example.com",
      token,
      platformHost: undefined,
      resolver: resolver({
        txt: {
          "_valmont-verify.shop.example.com": [[`valmont-verify=${token}`]],
        },
        cname: { "shop.example.com": ["anything.example"] },
      }),
    });
    expect(result.status).toBe("pending");
    expect(result.ownershipProven).toBe(true);
  });
});

describe("needsRecheck", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");

  it("re-checks a domain that was never checked or whose timestamp is unreadable", () => {
    expect(needsRecheck(null, now)).toBe(true);
    expect(needsRecheck("not a date", now)).toBe(true);
  });

  it("re-checks once the interval has elapsed and not before", () => {
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const stale = new Date(
      now.getTime() - DOMAIN_RECHECK_INTERVAL_MS - 1,
    ).toISOString();
    expect(needsRecheck(recent, now)).toBe(false);
    expect(needsRecheck(stale, now)).toBe(true);
  });
});
