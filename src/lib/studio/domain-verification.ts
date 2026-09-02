import dns from "node:dns/promises";
import {
  verificationRecordName,
  verificationRecordValue,
  type DomainStatus,
} from "./domains";

/**
 * Resolver seam. Production uses Node's resolver; tests inject a fake so no
 * network is touched and every branch is deterministic.
 */
export interface DomainResolver {
  resolveCname(hostname: string): Promise<string[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
}

export const systemResolver: DomainResolver = {
  resolveCname: (hostname) => dns.resolveCname(hostname),
  resolveTxt: (hostname) => dns.resolveTxt(hostname),
};

export interface DomainCheckResult {
  status: DomainStatus;
  /** True when the TXT proof was found for this draft's token. */
  ownershipProven: boolean;
  /** True when the CNAME points at the platform host. */
  cnameCorrect: boolean;
  /** Plain-language explanation for the owner; never includes raw DNS data. */
  detail: string;
}

const trimDot = (value: string) =>
  value.trim().toLowerCase().replace(/\.$/, "");

/** How often an `active` domain is re-verified in the background. */
export const DOMAIN_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Decides whether a hostname may be served for a draft.
 *
 * Two independent DNS facts are required, and BOTH must hold:
 *
 *  1. Ownership — a TXT record at `_valmont-verify.<hostname>` containing
 *     `valmont-verify=<token>`, where the token was minted for this specific
 *     draft. Only somebody who controls the zone can publish it, so a
 *     hostname cannot be attached to a draft by someone who merely knows the
 *     name — and a dangling CNAME left behind by a previous tenant proves
 *     nothing on its own.
 *  2. Routing — a CNAME whose target is the platform host, compared as an
 *     exact, case-insensitive DNS name. There is deliberately NO fallback to
 *     comparing resolved IP addresses: shared hosting, CDNs and NAT put
 *     unrelated names on the same address, so an address match is not
 *     evidence of anything.
 *
 * Without a configured platform host the routing check cannot be performed
 * and the domain stays `pending` — it is never marked active by default.
 */
export async function checkDomain(input: {
  hostname: string;
  token: string;
  platformHost: string | undefined;
  resolver?: DomainResolver;
}): Promise<DomainCheckResult> {
  const resolver = input.resolver ?? systemResolver;
  const expectedValue = verificationRecordValue(input.token);

  let ownershipProven = false;
  try {
    const records = await resolver.resolveTxt(
      verificationRecordName(input.hostname),
    );
    // A TXT record may be split into several strings; join before comparing.
    ownershipProven = records.some(
      (chunks) => chunks.join("").trim() === expectedValue,
    );
  } catch {
    ownershipProven = false;
  }

  const platformHost = input.platformHost ? trimDot(input.platformHost) : "";
  if (!platformHost) {
    return {
      status: "pending",
      ownershipProven,
      cnameCorrect: false,
      detail: ownershipProven
        ? "Ownership verified. The public Valmont address is not configured on this server yet, so the domain cannot be connected here."
        : "Add the TXT record to prove you own this domain. The public Valmont address is not configured on this server yet.",
    };
  }

  let cnameCorrect = false;
  try {
    const cnames = await resolver.resolveCname(input.hostname);
    cnameCorrect = cnames.some((target) => trimDot(target) === platformHost);
  } catch {
    cnameCorrect = false;
  }

  if (ownershipProven && cnameCorrect) {
    return {
      status: "active",
      ownershipProven,
      cnameCorrect,
      detail: "Connected. Ownership verified and the domain points at Valmont.",
    };
  }
  if (!ownershipProven && !cnameCorrect) {
    return {
      status: "pending",
      ownershipProven,
      cnameCorrect,
      detail:
        "Waiting for DNS. Add both records at your registrar: the TXT record to prove ownership and the CNAME to point the domain at Valmont.",
    };
  }
  if (!ownershipProven) {
    return {
      status: "error",
      ownershipProven,
      cnameCorrect,
      detail:
        "The domain points at Valmont but the ownership TXT record was not found. Add it so nobody else can claim this domain.",
    };
  }
  return {
    status: "error",
    ownershipProven,
    cnameCorrect,
    detail:
      "Ownership verified, but the CNAME record does not point at Valmont yet. Check the record's target.",
  };
}

/** True when an active domain's last check is old enough to repeat. */
export function needsRecheck(
  lastCheckedAt: string | null,
  now = new Date(),
): boolean {
  if (!lastCheckedAt) return true;
  const last = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= DOMAIN_RECHECK_INTERVAL_MS;
}
