/**
 * Stage 6b — the three sides never mix.
 *
 * The rule is structural, so the test is too: nothing under the shop admin
 * side (`/manage/[id]`, `/api/manage/[id]`, `src/lib/shop-admin` except the
 * one Studio-side guard, `src/components/shop-admin`) may import the agency
 * session (`@/lib/auth`) or the customer session (`@/lib/customer-auth`), and
 * the public storefront must not link to the admin pages. A future import
 * that breaks the wall fails here, before a reviewer has to spot it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(full);
  }
  return out;
}

const adminSideFiles = [
  ...walk(path.join(root, "src/app/manage")),
  ...walk(path.join(root, "src/app/api/manage")),
  ...walk(path.join(root, "src/components/shop-admin")),
  ...walk(path.join(root, "src/lib/shop-admin")).filter(
    // The Studio-side guard is the agency's, by design; it is the only file
    // in the module that may use the agency session.
    (file) => !file.endsWith("studio-routes.ts"),
  ),
];

const importPattern = (specifier: string) =>
  new RegExp(`from\\s+["']${specifier.replace("/", "\\/")}["']`);

describe("shop admin side", () => {
  it("has files to check", () => {
    expect(adminSideFiles.length).toBeGreaterThan(10);
  });

  it("never imports the agency session or the customer session", () => {
    const offenders = adminSideFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        importPattern("@/lib/auth").test(source) ||
        importPattern("@/lib/customer-auth").test(source) ||
        importPattern("@/lib/customer-account-store").test(source)
      );
    });
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });

  it("never renders the agency shell", () => {
    const offenders = adminSideFiles.filter((file) =>
      importPattern("@/components/app-shell").test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });

  it("uses its own cookie name", () => {
    const auth = readFileSync(
      path.join(root, "src/lib/shop-admin/auth.ts"),
      "utf8",
    );
    expect(auth).toContain('SHOP_SESSION_COOKIE = "valmont_shop_session"');
    expect(auth).not.toContain("valmont_customer_session");
    expect(auth).not.toContain('"valmont_session"');
  });
});

describe("the public storefront", () => {
  it("does not link to the admin pages", () => {
    const storefront = [
      ...walk(path.join(root, "src/app/s")),
      path.join(root, "src/components/studio/storefront.tsx"),
    ];
    expect(storefront.length).toBeGreaterThan(0);
    const offenders = storefront.filter((file) =>
      /\/manage\//.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });
});
