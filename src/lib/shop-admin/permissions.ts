/**
 * Stage 6b shop-admin permissions.
 *
 * There are no fixed roles beyond "owner" and "member". The owner ticks
 * permission boxes per person, and this file is the whole vocabulary: a
 * permission id that is not listed here cannot be stored, granted or checked.
 *
 * Stage 6b only ships the read-only dashboard, so today a member with any of
 * these boxes ticked still sees the same orders list as a member with none.
 * The ids are defined now so the owner can set the team up once and Stage 6c
 * (deliver, pause, price, supplier) can simply start honouring them.
 */
export const SHOP_PERMISSIONS = [
  "orders.fulfil",
  "bundles.manage",
  "supplier.manage",
  "reports.view",
] as const;

export type ShopPermission = (typeof SHOP_PERMISSIONS)[number];

/** Plain-language labels for the permission checkboxes on the Team page. */
export const SHOP_PERMISSION_LABELS: Record<ShopPermission, string> = {
  "orders.fulfil": "Deliver orders",
  "bundles.manage": "Pause bundles & change prices",
  "supplier.manage": "Supplier & float",
  "reports.view": "Sales & margin",
};

/**
 * Reserved and never grantable: topping up the supplier wallet moves real
 * money, and Stage 6b decided that no permission box may ever unlock it — not
 * for members, and not through any future default. Kept as a named constant
 * so the allow-list test can prove it is rejected by name.
 */
export const RESERVED_SHOP_PERMISSION = "wallets.topup" as const;

/** Hard cap on logins per website (owner included). */
export const MAX_SHOP_LOGINS_PER_WEBSITE = 10;

export type ShopAdminRole = "owner" | "member";

/** The slice of an admin row that permission checks need. */
export interface ShopAdminPermissionSubject {
  role: ShopAdminRole;
  permissions: readonly string[];
}

export function isShopPermission(value: unknown): value is ShopPermission {
  return (
    typeof value === "string" &&
    (SHOP_PERMISSIONS as readonly string[]).includes(value)
  );
}

/**
 * Allow-list parser for stored or submitted permission lists. Accepts a JSON
 * string (the database column) or an already-parsed array; anything that is
 * not a known permission id is silently dropped, duplicates collapse, and the
 * output keeps the canonical `SHOP_PERMISSIONS` order so two equal grants
 * always serialise identically. Malformed JSON yields an empty grant rather
 * than an error — a corrupt row must fail closed, never open.
 */
export function parsePermissions(input: unknown): ShopPermission[] {
  let values: unknown = input;
  if (typeof input === "string") {
    try {
      values = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(values)) return [];
  const granted = new Set<ShopPermission>();
  for (const value of values) {
    if (isShopPermission(value)) granted.add(value);
  }
  return SHOP_PERMISSIONS.filter((permission) => granted.has(permission));
}

/** Canonical JSON for the `permissions` column. */
export function serializePermissions(input: unknown): string {
  return JSON.stringify(parsePermissions(input));
}

/**
 * Whether an admin may do something. The owner always may; a member only when
 * the owner ticked that box. The reserved wallet permission is never granted
 * to anyone — the owner included — because it is not a shop-admin capability
 * at all in Stage 6b.
 */
export function can(
  admin: ShopAdminPermissionSubject | null | undefined,
  permission: string,
): boolean {
  if (!admin) return false;
  if (permission === RESERVED_SHOP_PERMISSION) return false;
  if (!isShopPermission(permission)) return false;
  if (admin.role === "owner") return true;
  return parsePermissions([...admin.permissions]).includes(permission);
}
