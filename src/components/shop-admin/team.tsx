"use client";

import { useState, type FormEvent } from "react";
import { apiMutation, apiPatch, ApiError } from "@/lib/client-api";
import {
  MAX_SHOP_LOGINS_PER_WEBSITE,
  SHOP_PERMISSION_LABELS,
  SHOP_PERMISSIONS,
  type ShopPermission,
} from "@/lib/shop-admin/permissions";
import type { ShopAdmin } from "@/lib/shop-admin/store";

/**
 * The owner's team manager (Stage 6b). Invite by name and email, tick
 * permission boxes per person, disable or re-enable. No fixed roles: what a
 * member may do is exactly the boxes the owner ticked. The owner's own row is
 * shown but locked — changing the owner is the agency's job, from Studio.
 *
 * Stage 6b ships the boxes ahead of the actions they unlock (that is Stage
 * 6c); the note under the form says so, so nobody expects a ticked box to
 * change what the dashboard shows today.
 */

const STATUS_LABEL: Record<ShopAdmin["status"], string> = {
  invited: "Invited",
  active: "Active",
  disabled: "Disabled",
};

const STATUS_CLASS: Record<ShopAdmin["status"], string> = {
  invited: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  disabled: "bg-slate-200 text-slate-700",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "We could not complete that request. Please try again.";
}

function PermissionBoxes({
  idPrefix,
  value,
  disabled,
  onChange,
}: {
  idPrefix: string;
  value: ShopPermission[];
  disabled?: boolean;
  onChange: (next: ShopPermission[]) => void;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {SHOP_PERMISSIONS.map((permission) => {
        const checked = value.includes(permission);
        const inputId = `${idPrefix}-${permission}`;
        return (
          <label
            key={permission}
            htmlFor={inputId}
            className="flex items-center gap-2 text-sm text-navy"
          >
            <input
              id={inputId}
              type="checkbox"
              className="size-4 accent-navy"
              checked={checked}
              disabled={disabled}
              data-testid={`perm-${permission}`}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, permission]
                    : value.filter((entry) => entry !== permission),
                )
              }
            />
            {SHOP_PERMISSION_LABELS[permission]}
          </label>
        );
      })}
    </div>
  );
}

export function TeamManager({
  draftId,
  ownerId,
  initialAdmins,
  emailConfigured,
}: {
  draftId: string;
  ownerId: string;
  initialAdmins: ShopAdmin[];
  emailConfigured: boolean;
}) {
  const [admins, setAdmins] = useState(initialAdmins);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [permissions, setPermissions] = useState<ShopPermission[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const url = `/api/manage/${encodeURIComponent(draftId)}/team`;
  const atCap = admins.length >= MAX_SHOP_LOGINS_PER_WEBSITE;

  function replaceAdmin(updated: ShopAdmin) {
    setAdmins((current) =>
      current.map((admin) => (admin.id === updated.id ? updated : admin)),
    );
  }

  async function run(action: string, work: () => Promise<void>) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("invite", async () => {
      const result = await apiMutation<{
        admin: ShopAdmin;
        delivered: boolean;
      }>(url, { name, email, permissions });
      setAdmins((current) => [...current, result.admin]);
      setName("");
      setEmail("");
      setPermissions([]);
      setNotice(
        result.delivered
          ? `We emailed ${result.admin.email} a link to set their password.`
          : `${result.admin.name} has been added. Email is not set up for this shop, so ask the person who built your website to send them the invite link.`,
      );
    });
  }

  return (
    <div className="grid gap-5">
      <ul className="grid gap-2" data-testid="shop-team-list">
        {admins.map((admin) => {
          const isOwner = admin.role === "owner";
          const isSelf = admin.id === ownerId;
          return (
            <li
              key={admin.id}
              className="rounded-xl border border-line bg-white p-4"
              data-testid="shop-team-row"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-navy">
                    {admin.name}
                    {isOwner && (
                      <span className="ml-1 text-xs font-normal text-slate-500">
                        (owner{isSelf ? ", you" : ""})
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-600">
                    {admin.email}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[admin.status]}`}
                >
                  {STATUS_LABEL[admin.status]}
                </span>
              </div>

              {isOwner ? (
                <p className="mt-3 text-xs text-slate-600">
                  The owner can do everything the shop admin allows. To change
                  the owner login, ask the person who built your website.
                </p>
              ) : (
                <>
                  <div className="mt-3">
                    <PermissionBoxes
                      idPrefix={`team-${admin.id}`}
                      value={admin.permissions}
                      disabled={busy !== null || admin.status === "disabled"}
                      onChange={(next) =>
                        void run(`perms-${admin.id}`, async () => {
                          const result = await apiPatch<{ admin: ShopAdmin }>(
                            `${url}/${admin.id}`,
                            { permissions: next },
                          );
                          replaceAdmin(result.admin);
                        })
                      }
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {admin.status === "invited" && (
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy !== null}
                        data-testid="shop-team-resend"
                        onClick={() =>
                          void run(`resend-${admin.id}`, async () => {
                            const result = await apiMutation<{
                              admin: ShopAdmin;
                              delivered: boolean;
                            }>(`${url}/${admin.id}/resend`, {});
                            setNotice(
                              result.delivered
                                ? `We emailed ${admin.email} a fresh link.`
                                : "Email is not set up for this shop. Ask the person who built your website to send the invite link.",
                            );
                          })
                        }
                      >
                        Resend invite
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-quiet text-xs"
                      disabled={busy !== null}
                      data-testid="shop-team-toggle"
                      onClick={() =>
                        void run(`toggle-${admin.id}`, async () => {
                          const result = await apiPatch<{ admin: ShopAdmin }>(
                            `${url}/${admin.id}`,
                            {
                              status:
                                admin.status === "disabled"
                                  ? "active"
                                  : "disabled",
                            },
                          );
                          replaceAdmin(result.admin);
                          setNotice(
                            admin.status === "disabled"
                              ? `${admin.name} can sign in again.`
                              : `${admin.name} has been signed out and can no longer sign in.`,
                          );
                        })
                      }
                    >
                      {admin.status === "disabled" ? "Enable" : "Disable"}
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <section className="rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Add someone</h2>
        <p className="mt-1 text-xs text-slate-600">
          They get a link to choose their own password. You never see it.
          {!emailConfigured &&
            " Email is not set up for this shop, so the person who built your website will pass the link on."}
        </p>
        {atCap ? (
          <p
            className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"
            data-testid="shop-team-cap"
          >
            This shop already has {MAX_SHOP_LOGINS_PER_WEBSITE} logins. Disable
            someone before adding another.
          </p>
        ) : (
          <form className="mt-3 grid gap-3" onSubmit={invite}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="team-invite-name">
                  Name
                </label>
                <input
                  className="input"
                  id="team-invite-name"
                  data-testid="team-invite-name"
                  type="text"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="team-invite-email">
                  Email
                </label>
                <input
                  className="input"
                  id="team-invite-email"
                  data-testid="team-invite-email"
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            </div>
            <div>
              <p className="label">What they may do</p>
              <PermissionBoxes
                idPrefix="team-invite"
                value={permissions}
                disabled={busy !== null}
                onChange={setPermissions}
              />
              <p className="mt-1 text-xs text-slate-500">
                Everyone can see orders. These boxes decide what else they can
                do once those actions arrive; you can change them later.
              </p>
            </div>
            <button
              type="submit"
              className="btn-primary w-fit"
              disabled={busy !== null || !name.trim() || !email.trim()}
              data-testid="team-invite-submit"
            >
              {busy === "invite" ? "Adding…" : "Send invite"}
            </button>
          </form>
        )}
      </section>

      {notice && (
        <p
          className="rounded-lg bg-pass-soft px-3 py-2 text-sm text-pass-strong"
          role="status"
          data-testid="shop-team-notice"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          className="rounded-lg bg-fail-soft px-3 py-2 text-sm text-fail-strong"
          role="alert"
          data-testid="shop-team-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
