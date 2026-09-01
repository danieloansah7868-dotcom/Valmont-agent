import type { ManifestEntry } from "./migration-manifest";

export interface LedgerRow {
  hash: string;
  created_at: number | string | bigint;
}

export interface VerificationResult {
  ok: boolean;
  expected: number;
  applied: number;
  missing: ManifestEntry[];
  unexpected: LedgerRow[];
  altered: Array<{ manifest: ManifestEntry; ledger: LedgerRow }>;
  duplicateLedgerHashes: string[];
  duplicateLedgerTimestamps: Array<number | string>;
}

function normalizeTimestamp(value: number | string | bigint): string {
  // Drizzle stores created_at as bigint, but it may come back as string/number
  return String(value);
}

export function verifyLedger(
  ledgerRows: LedgerRow[],
  manifest: ManifestEntry[],
): VerificationResult {
  const result: VerificationResult = {
    ok: false,
    expected: manifest.length,
    applied: ledgerRows.length,
    missing: [],
    unexpected: [],
    altered: [],
    duplicateLedgerHashes: [],
    duplicateLedgerTimestamps: [],
  };

  // Detect duplicates in ledger
  const hashCount = new Map<string, number>();
  const timestampCount = new Map<string, number>();

  for (const row of ledgerRows) {
    const h = row.hash;
    hashCount.set(h, (hashCount.get(h) ?? 0) + 1);
    const ts = normalizeTimestamp(row.created_at);
    timestampCount.set(ts, (timestampCount.get(ts) ?? 0) + 1);
  }

  for (const [hash, count] of hashCount.entries()) {
    if (count > 1) result.duplicateLedgerHashes.push(hash);
  }
  for (const [ts, count] of timestampCount.entries()) {
    if (count > 1) result.duplicateLedgerTimestamps.push(ts);
  }

  if (
    result.duplicateLedgerHashes.length > 0 ||
    result.duplicateLedgerTimestamps.length > 0
  ) {
    return result;
  }

  // Build maps for quick lookup
  const manifestByHash = new Map<string, ManifestEntry>();
  const manifestByTimestamp = new Map<string, ManifestEntry>();
  for (const entry of manifest) {
    manifestByHash.set(entry.hash, entry);
    manifestByTimestamp.set(String(entry.when), entry);
  }

  const ledgerByHash = new Map<string, LedgerRow>();
  const ledgerByTimestamp = new Map<string, LedgerRow>();
  for (const row of ledgerRows) {
    ledgerByHash.set(row.hash, row);
    ledgerByTimestamp.set(normalizeTimestamp(row.created_at), row);
  }

  // Check for missing manifest entries in ledger
  for (const entry of manifest) {
    const byHash = ledgerByHash.get(entry.hash);
    const byTs = ledgerByTimestamp.get(String(entry.when));
    if (!byHash || !byTs) {
      result.missing.push(entry);
    } else {
      // Ensure hash and timestamp belong to same ledger row (not cross-matched)
      if (
        normalizeTimestamp(byHash.created_at) !== String(entry.when) ||
        normalizeTimestamp(byTs.created_at) !== String(entry.when) ||
        byHash.hash !== entry.hash
      ) {
        result.altered.push({ manifest: entry, ledger: byHash });
      }
    }
  }

  // Check for unexpected ledger rows (not in manifest)
  for (const row of ledgerRows) {
    const expectedByHash = manifestByHash.get(row.hash);
    const expectedByTs = manifestByTimestamp.get(
      normalizeTimestamp(row.created_at),
    );
    if (!expectedByHash || !expectedByTs) {
      result.unexpected.push(row);
    } else {
      // If hash matches but timestamp doesn't match that manifest entry's timestamp,
      // it's altered
      if (
        String(expectedByHash.when) !== normalizeTimestamp(row.created_at) ||
        String(expectedByTs.when) !== normalizeTimestamp(row.created_at) ||
        expectedByHash.hash !== row.hash
      ) {
        // Already captured as altered if missing check didn't catch, but ensure
        if (
          !result.altered.some((a) => a.manifest.hash === expectedByHash.hash)
        ) {
          result.altered.push({
            manifest: expectedByHash,
            ledger: row,
          });
        }
      }
    }
  }

  // More precise: exact membership requires every manifest entry has exact matching ledger row
  // and no extra rows.
  const exactMatches = manifest.every((entry) => {
    const row = ledgerByHash.get(entry.hash);
    return row && normalizeTimestamp(row.created_at) === String(entry.when);
  });

  const noExtra = ledgerRows.every((row) => {
    const manifestEntry = manifestByHash.get(row.hash);
    return (
      manifestEntry &&
      String(manifestEntry.when) === normalizeTimestamp(row.created_at)
    );
  });

  result.ok =
    exactMatches &&
    noExtra &&
    result.missing.length === 0 &&
    result.unexpected.length === 0 &&
    result.altered.length === 0 &&
    result.duplicateLedgerHashes.length === 0 &&
    result.duplicateLedgerTimestamps.length === 0 &&
    ledgerRows.length === manifest.length;

  return result;
}
