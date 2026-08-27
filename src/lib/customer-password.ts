import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

const KEY_LENGTH = 32;
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

/**
 * A valid, fixed-cost hash used for login attempts against unknown emails.
 * Running the same scrypt work on both paths avoids a remote timing oracle;
 * this value is never associated with a real account.
 */
export const DUMMY_CUSTOMER_PASSWORD_HASH =
  "scrypt$N=32768,r=8,p=1$dmFsbW9udC1kdW1teS1zYWx0LTE2$ieBH5rbJOt3P2-W5S0NDHYRNnFknDyRYk7DDr5ZitlY";

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derived as Buffer);
    });
  });
}

/**
 * Passwords are deliberately kept independent from the application owner's
 * GitHub session. The encoded format carries the parameters so a future cost
 * increase can be introduced without invalidating existing accounts.
 */
export async function hashCustomerPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  });

  return [
    "scrypt",
    `N=${COST},r=${BLOCK_SIZE},p=${PARALLELIZATION}`,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyCustomerPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, parameters, saltValue, digestValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !parameters || !saltValue || !digestValue) {
    return false;
  }

  const values = new Map(
    parameters.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, Number(value)] as const;
    }),
  );
  const cost = values.get("N") ?? 0;
  const blockSize = values.get("r") ?? 0;
  const parallelization = values.get("p") ?? 0;
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelization) ||
    cost < 16_384 ||
    cost > 1_048_576 ||
    blockSize < 1 ||
    blockSize > 32 ||
    parallelization < 1 ||
    parallelization > 8
  ) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltValue, "base64url");
    expected = Buffer.from(digestValue, "base64url");
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;

  const derived = await deriveKey(password, salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: Math.max(MAX_MEMORY, 128 * cost * blockSize + 1024),
  });
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Avoid retaining the original secret in a token table or log line. */
export function hashCustomerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createCustomerToken(): string {
  return randomBytes(32).toString("base64url");
}
