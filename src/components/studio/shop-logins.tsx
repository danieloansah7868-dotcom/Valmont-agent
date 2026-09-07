"use client";

import { useCallback, useEffect, useState } from "react";
import { apiMutation, apiPatch, ApiError } from "@/lib/client-api";

/**
 * The "Shop logins" card on a data-bundles draft (Stage 6b).
 *
 * This is where the agency user hands the website over: they create the shop
 * owner's login (name + email) and the owner gets a one-time link to choose a
 * password. From then on the owner runs the shop from `/manage/[id]` and adds
 * their own staff there — the agency user never sees or sets a shop
 * password, and this card never shows one.
 *
 * Delivery follows the server's rule. When email is configured the link is
 * emailed and the card only confirms that. When it is not, the server returns
 * the link exactly once and the card shows it with "Send this link to the
 * owner on WhatsApp" — the agency user is already trusted with the whole
 * website, so trusting them with one 24-hour link is no new exposure.
 */

interface ShopAdminView {
  id: string;
  email: string;
  name: string;
  role: "owner" | "member";
  status: "invited" | "active" | "disabled";
  hasPassword: boolean;
  lastLoginAt: string | null;
}

interface ListResponse {
  admins: ShopAdminView[];
  emailConfigured: boolean;
}

interface LinkResponse {
  admin: ShopAdminView;
  delivered: boolean;
  expiresAt: string;
  link?: string;
}

const STATUS_LABEL: Record<ShopAdminView["status"], string> = {
  invited: "Invited",
  active: "Active",
  disabled: "Disabled",
};

const STATUS_CLASS: Record<ShopAdminView["status"], string> = {
  invited: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  disabled: "bg-slate-200 text-slate-700",
};

export function ShopLoginsCard({ draftId }: { draftId: string }) {
  const [loading, setLoading] = useState(true);
  const [admins, setAdmins] = useState<ShopAdminView[]>([]);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);

  const url = `/api/studio/drafts/${draftId}/shop-admins`;

  /** Reads the list. No state is touched, so it is safe to call anywhere. */
  const fetchList = useCallback(async (): Promise<ListResponse | null> => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to load");
      return (await response.json()) as ListResponse;
    } catch (cause) {
      console.error(cause);
      return null;
    }
  }, [url]);

  /** Re-reads after an action, so the list reflects what the server holds. */
  const load = useCallback(async () => {
    const next = await fetchList();
    if (next) {
      setAdmins(next.admins);
      setEmailConfigured(next.emailConfigured);
    }
  }, [fetchList]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      const next = await fetchList();
      if (cancelled) return;
      if (next) {
        setAdmins(next.admins);
        setEmailConfigured(next.emailConfigured);
      }
      setLoading(false);
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, [fetchList]);

  function messageOf(cause: unknown, fallback: string): string {
    return cause instanceof ApiError ? cause.message : fallback;
  }

  function showDelivery(result: LinkResponse, emailedMessage: string) {
    if (result.link) {
      setOneTimeLink(result.link);
      setNotice(null);
    } else {
      setOneTimeLink(null);
      setNotice(emailedMessage);
    }
  }

  async function run(
    action: string,
    work: () => Promise<void>,
    fallback: string,
  ) {
    setBusy(action);
    setError(null);
    try {
      await work();
      await load();
    } catch (cause) {
      setError(messageOf(cause, fallback));
    } finally {
      setBusy(null);
    }
  }

  const owner = admins.find((admin) => admin.role === "owner") ?? null;
  const members = admins.filter((admin) => admin.role !== "owner");

  return (
    <section
      id="shop-logins-card"
      data-testid="shop-logins-card"
      className="mt-4 scroll-mt-24 rounded-xl border border-line bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-navy">Shop logins</h2>
        {owner && (
          <span
            data-testid="shop-owner-status"
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[owner.status]}`}
          >
            Owner · {STATUS_LABEL[owner.status]}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs text-slate-600">
        The shop owner signs in at{" "}
        <span className="font-mono break-all">/manage/{draftId}</span> to see
        orders and add their own staff. You create the owner&apos;s login here;
        you never see or set their password.
      </p>

      {loading ? (
        <p className="mt-3 text-xs text-slate-500">Loading…</p>
      ) : !owner ? (
        <form
          className="mt-3 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "invite",
              async () => {
                const result = await apiMutation<LinkResponse>(url, {
                  name,
                  email,
                });
                setName("");
                setEmail("");
                showDelivery(
                  result,
                  `We emailed ${result.admin.email} a link to set their password.`,
                );
              },
              "The owner login could not be created.",
            );
          }}
        >
          <label htmlFor="shop-owner-name" className="sr-only">
            Owner&apos;s name
          </label>
          <input
            id="shop-owner-name"
            data-testid="shop-owner-name"
            type="text"
            autoComplete="off"
            placeholder="Owner's name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm"
          />
          <label htmlFor="shop-owner-email" className="sr-only">
            Owner&apos;s email
          </label>
          <input
            id="shop-owner-email"
            data-testid="shop-owner-email"
            type="email"
            autoComplete="off"
            placeholder="owner@example.com"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            data-testid="shop-owner-invite"
            disabled={busy !== null || !name.trim() || !email.trim()}
            className="btn-primary w-fit text-xs"
          >
            {busy === "invite" ? "Creating…" : "Create owner login"}
          </button>
        </form>
      ) : (
        <ul className="mt-3 divide-y divide-line text-sm">
          {[owner, ...members].map((admin) => (
            <li
              key={admin.id}
              data-testid="shop-login-row"
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-navy">
                  {admin.name}
                  {admin.role === "owner" && (
                    <span className="ml-1 text-xs font-normal text-slate-500">
                      (owner)
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-slate-600">
                  {admin.email}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[admin.status]}`}
                >
                  {STATUS_LABEL[admin.status]}
                </span>
                {admin.status === "invited" && (
                  <button
                    type="button"
                    data-testid="shop-login-resend"
                    disabled={busy !== null}
                    className="btn-secondary text-xs"
                    onClick={() =>
                      void run(
                        `resend-${admin.id}`,
                        async () => {
                          const result = await apiMutation<LinkResponse>(
                            `${url}/${admin.id}/resend`,
                            {},
                          );
                          showDelivery(
                            result,
                            `We emailed ${admin.email} a fresh link.`,
                          );
                        },
                        "The invite could not be resent.",
                      )
                    }
                  >
                    {busy === `resend-${admin.id}` ? "Sending…" : "Resend link"}
                  </button>
                )}
                {admin.status === "active" && (
                  <button
                    type="button"
                    data-testid="shop-login-reset"
                    disabled={busy !== null}
                    className="btn-secondary text-xs"
                    onClick={() =>
                      void run(
                        `reset-${admin.id}`,
                        async () => {
                          const result = await apiMutation<LinkResponse>(
                            `${url}/${admin.id}/reset-link`,
                            {},
                          );
                          showDelivery(
                            result,
                            `We emailed ${admin.email} a password-reset link.`,
                          );
                        },
                        "The reset link could not be created.",
                      )
                    }
                  >
                    {busy === `reset-${admin.id}` ? "Sending…" : "Reset link"}
                  </button>
                )}
                <button
                  type="button"
                  data-testid="shop-login-toggle"
                  disabled={busy !== null}
                  className="btn-quiet text-xs"
                  onClick={() =>
                    void run(
                      `toggle-${admin.id}`,
                      async () => {
                        await apiPatch(`${url}/${admin.id}`, {
                          status:
                            admin.status === "disabled" ? "active" : "disabled",
                        });
                        setOneTimeLink(null);
                        setNotice(
                          admin.status === "disabled"
                            ? `${admin.name} can sign in again.`
                            : `${admin.name} has been signed out and can no longer sign in.`,
                        );
                      },
                      "The login could not be updated.",
                    )
                  }
                >
                  {admin.status === "disabled" ? "Enable" : "Disable"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {oneTimeLink && (
        <div
          data-testid="shop-login-link"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
        >
          <p className="font-semibold">
            Send this link to the owner on WhatsApp
          </p>
          <p className="mt-1">
            Email is not set up on this deployment, so the link is shown here
            once. It works one time and expires in 24 hours (reset links in 1
            hour).
          </p>
          <p className="mt-2 rounded bg-white px-2 py-1 font-mono break-all select-all">
            {oneTimeLink}
          </p>
        </div>
      )}

      {notice && (
        <p
          className="mt-3 text-xs text-emerald-700"
          data-testid="shop-login-notice"
        >
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-3 text-xs text-red-600" data-testid="shop-login-error">
          {error}
        </p>
      )}
      {!loading && !emailConfigured && !oneTimeLink && (
        <p className="mt-3 text-[11px] text-slate-500">
          Email is not configured on this deployment, so invite and reset links
          are shown here once for you to pass on.
        </p>
      )}
    </section>
  );
}
