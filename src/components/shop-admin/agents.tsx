"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ApiError, apiMutation, apiPatch } from "@/lib/client-api";
import { formatMoney } from "@/lib/studio/money";
import type { ShopAgent, WalletEntry } from "@/lib/shop-agent/store";

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "We could not complete that request. Please try again.";
}

function statusLabel(status: ShopAgent["status"]): string {
  return status === "active"
    ? "Active"
    : status === "disabled"
      ? "Disabled"
      : "Invited";
}

export function AgentsManager({
  draftId,
  initialAgents,
  initialDiscount,
  emailConfigured,
}: {
  draftId: string;
  initialAgents: ShopAgent[];
  initialDiscount: number;
  emailConfigured: boolean;
}) {
  const [agents, setAgents] = useState(initialAgents);
  const [discount, setDiscount] = useState(String(initialDiscount));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [walletAction, setWalletAction] = useState<{
    agent: ShopAgent;
    kind: "credit" | "deduct";
  } | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const base = `/api/manage/${encodeURIComponent(draftId)}`;
  const agentsUrl = `${base}/agents`;

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

  async function saveDiscount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("discount", async () => {
      const result = await apiPatch<{ settings: { discountPercent: number } }>(
        `${base}/agent-settings`,
        { discountPercent: Number(discount) },
      );
      setDiscount(String(result.settings.discountPercent));
      setNotice("Agent pricing saved.");
    });
  }

  async function addAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("add", async () => {
      const result = await apiMutation<{
        agent: ShopAgent;
        delivered: boolean;
      }>(agentsUrl, { name, email, phone: phone || undefined });
      setAgents((current) => [...current, result.agent]);
      setName("");
      setEmail("");
      setPhone("");
      setNotice(
        result.delivered
          ? `We emailed ${result.agent.email} an invite link.`
          : "The agent was added. Email is not configured, so ask Valmont to send the invite link.",
      );
    });
  }

  async function toggleAgent(agent: ShopAgent) {
    await run(`status-${agent.id}`, async () => {
      const result = await apiPatch<{ agent: ShopAgent }>(
        `${agentsUrl}/${agent.id}`,
        { status: agent.status === "disabled" ? "active" : "disabled" },
      );
      setAgents((current) =>
        current.map((item) => (item.id === agent.id ? result.agent : item)),
      );
    });
  }

  async function resend(agent: ShopAgent) {
    await run(`resend-${agent.id}`, async () => {
      const result = await apiMutation<{ delivered: boolean }>(
        `${agentsUrl}/${agent.id}/invite`,
        {},
      );
      setNotice(
        result.delivered
          ? `We emailed ${agent.email} a fresh invite.`
          : "Email is not configured, so ask Valmont to send the invite link.",
      );
    });
  }

  async function saveWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!walletAction) return;
    const action = walletAction;
    await run(`wallet-${action.agent.id}`, async () => {
      const result = await apiMutation<{
        entry: WalletEntry;
        agent: ShopAgent;
      }>(`${agentsUrl}/${action.agent.id}/wallet`, {
        kind: action.kind,
        amount: Number(amount),
        note: note || undefined,
      });
      setAgents((current) =>
        current.map((item) =>
          item.id === action.agent.id ? result.agent : item,
        ),
      );
      setNotice(
        `${action.kind === "credit" ? "Added" : "Removed"} ${formatMoney(Number(amount))} from ${action.agent.name}'s wallet.`,
      );
      setWalletAction(null);
      setAmount("");
      setNote("");
    });
  }

  return (
    <div className="grid gap-5">
      <form className="card grid gap-3 p-4" onSubmit={saveDiscount}>
        <div>
          <h2 className="text-sm font-semibold text-navy">Agent price</h2>
          <p className="mt-1 text-xs text-slate-600">
            Agent price: agents pay this many percent below the shop price.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm text-navy">
            <span className="sr-only">Discount percent</span>
            <input
              className="input w-28"
              type="number"
              min={0}
              max={50}
              step={1}
              value={discount}
              data-testid="shop-agents-discount"
              onChange={(event) => setDiscount(event.target.value)}
            />
          </label>
          <span className="pb-2 text-sm text-slate">%</span>
          <button
            className="btn-secondary"
            disabled={busy !== null}
            data-testid="shop-agents-discount-save"
          >
            Save
          </button>
        </div>
      </form>

      {!emailConfigured && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Email is not set up on this server yet, so invite links cannot be
          sent. Ask Valmont to enable email.
        </p>
      )}
      <form
        className="card grid gap-3 p-4"
        onSubmit={addAgent}
        data-testid="shop-agents-add"
      >
        <h2 className="text-sm font-semibold text-navy">Add agent</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            className="input"
            required
            minLength={1}
            maxLength={120}
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="input"
            required
            type="email"
            maxLength={254}
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            className="input"
            maxLength={30}
            placeholder="Phone (optional)"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        <button
          className="btn-primary justify-self-start"
          disabled={busy !== null || !emailConfigured}
        >
          Add agent
        </button>
      </form>

      {error && (
        <p
          className="rounded-lg bg-fail-soft px-3 py-2 text-sm text-fail-strong"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          className="rounded-lg bg-pass-soft px-3 py-2 text-sm text-pass-strong"
          role="status"
        >
          {notice}
        </p>
      )}

      <ul className="grid gap-2" data-testid="shop-agents-list">
        {agents.map((agent) => (
          <li
            key={agent.id}
            className="rounded-xl border border-line bg-white p-4"
            data-testid="shop-agent-row"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-navy">{agent.name}</p>
                <p className="text-xs text-slate-600">
                  {agent.email}
                  {agent.phone ? ` · ${agent.phone}` : ""}
                </p>
              </div>
              <span className="rounded-full bg-ivory-100 px-2 py-0.5 text-xs font-semibold text-navy">
                {statusLabel(agent.status)}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span
                data-testid="shop-agent-balance"
                className="font-semibold text-navy"
              >
                {formatMoney(agent.balance)}
              </span>
              <span className="text-slate">
                {agent.lastLoginAt
                  ? `Last login ${new Date(agent.lastLoginAt).toLocaleDateString("en-GB")}`
                  : "No login yet"}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary text-xs"
                data-testid="shop-agent-credit"
                disabled={busy !== null || agent.status === "disabled"}
                onClick={() => {
                  setWalletAction({ agent, kind: "credit" });
                  setAmount("");
                  setNote("");
                }}
              >
                Add credit
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                data-testid="shop-agent-deduct"
                disabled={busy !== null || agent.status === "disabled"}
                onClick={() => {
                  setWalletAction({ agent, kind: "deduct" });
                  setAmount("");
                  setNote("");
                }}
              >
                Remove credit
              </button>
              <button
                type="button"
                className="btn-quiet text-xs"
                data-testid={
                  agent.status === "disabled"
                    ? "shop-agent-enable"
                    : "shop-agent-disable"
                }
                disabled={busy !== null}
                onClick={() => void toggleAgent(agent)}
              >
                {agent.status === "disabled" ? "Enable" : "Disable"}
              </button>
              {agent.status === "invited" && (
                <button
                  type="button"
                  className="btn-quiet text-xs"
                  data-testid="shop-agent-resend"
                  disabled={busy !== null || !emailConfigured}
                  onClick={() => void resend(agent)}
                >
                  Resend invite
                </button>
              )}
              <Link
                className="btn-quiet text-xs"
                href={`/manage/${encodeURIComponent(draftId)}/agents/${encodeURIComponent(agent.id)}`}
              >
                Statement
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {walletAction && (
        <div
          className="card grid gap-3 border-copper p-4"
          role="dialog"
          aria-label="Wallet change"
        >
          <h2 className="font-semibold text-navy">
            {walletAction.kind === "credit" ? "Add credit" : "Remove credit"}{" "}
            for {walletAction.agent.name}
          </h2>
          <form className="grid gap-3" onSubmit={saveWallet}>
            <input
              className="input"
              required
              type="number"
              min="0.01"
              max="5000"
              step="0.01"
              placeholder="Amount in GHS"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <input
              className="input"
              maxLength={140}
              placeholder="Note (optional)"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="text-sm text-slate">
              Balance after:{" "}
              {formatMoney(
                walletAction.agent.balance +
                  (walletAction.kind === "credit"
                    ? Number(amount || 0)
                    : -Number(amount || 0)),
              )}
            </p>
            <div className="flex gap-2">
              <button className="btn-primary" disabled={busy !== null}>
                Confirm
              </button>
              <button
                type="button"
                className="btn-quiet"
                onClick={() => setWalletAction(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
