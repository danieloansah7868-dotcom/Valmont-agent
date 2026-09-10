"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiMutation } from "@/lib/client-api";

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "We could not complete that request. Please try again.";
}
function Message({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return (
    <p
      className={
        error
          ? "rounded-lg bg-fail-soft px-3 py-2 text-sm text-fail-strong"
          : "rounded-lg bg-pass-soft px-3 py-2 text-sm text-pass-strong"
      }
      role={error ? "alert" : "status"}
    >
      {error || success}
    </p>
  );
}
const passwordHelp = "At least 10 characters.";

export function AgentLoginForm({
  draftId,
  next,
}: {
  draftId: string;
  next?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await apiMutation<{ next: string }>(
        `/api/a/${encodeURIComponent(draftId)}/auth/login`,
        { email, password, next },
      );
      router.push(result.next || `/a/${encodeURIComponent(draftId)}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <form
      className="grid gap-4"
      onSubmit={submit}
      data-testid="agent-login-form"
    >
      <div>
        <label className="label" htmlFor="agent-login-email">
          Email address
        </label>
        <input
          className="input"
          id="agent-login-email"
          data-testid="agent-login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <div className="flex items-center justify-between gap-3">
          <label className="label mb-0" htmlFor="agent-login-password">
            Password
          </label>
          <Link
            href={`/a/${encodeURIComponent(draftId)}/forgot-password`}
            className="text-xs font-semibold text-copper-700 hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <input
          className="input mt-2"
          id="agent-login-password"
          data-testid="agent-login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <Message error={error} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="agent-login-submit"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function AgentAcceptInviteForm({
  draftId,
  token,
  initialName,
}: {
  draftId: string;
  token: string;
  initialName: string;
}) {
  const [name, setName] = useState(initialName);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await apiMutation(
        `/api/a/${encodeURIComponent(draftId)}/auth/accept-invite`,
        { token, name, password },
      );
      router.push(`/a/${encodeURIComponent(draftId)}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <form
      className="grid gap-4"
      onSubmit={submit}
      data-testid="agent-accept-invite-form"
    >
      <div>
        <label className="label" htmlFor="agent-accept-name">
          Your name
        </label>
        <input
          className="input"
          id="agent-accept-name"
          data-testid="agent-accept-name"
          type="text"
          autoComplete="name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="agent-accept-password">
          Choose a password
        </label>
        <input
          className="input"
          id="agent-accept-password"
          data-testid="agent-accept-password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate">{passwordHelp}</p>
      </div>
      <div>
        <label className="label" htmlFor="agent-accept-confirm">
          Type it again
        </label>
        <input
          className="input"
          id="agent-accept-confirm"
          data-testid="agent-accept-confirm"
          type="password"
          minLength={10}
          maxLength={128}
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      <Message error={error} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="agent-accept-submit"
      >
        {busy ? "Saving…" : "Set password and sign in"}
      </button>
    </form>
  );
}

export function AgentForgotPasswordForm({ draftId }: { draftId: string }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await apiMutation(
        `/api/a/${encodeURIComponent(draftId)}/auth/forgot-password`,
        { email },
      );
      setSuccess("If that email exists, we sent a link.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="grid gap-4"
      onSubmit={submit}
      data-testid="agent-forgot-form"
    >
      <div>
        <label className="label" htmlFor="agent-forgot-email">
          Email address
        </label>
        <input
          className="input"
          id="agent-forgot-email"
          data-testid="agent-forgot-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <Message error={error} success={success} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="agent-forgot-submit"
      >
        {busy ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}

export function AgentResetPasswordForm({
  draftId,
  token,
}: {
  draftId: string;
  token: string;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await apiMutation(
        `/api/a/${encodeURIComponent(draftId)}/auth/reset-password`,
        { token, password },
      );
      router.push(`/a/${encodeURIComponent(draftId)}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <form
      className="grid gap-4"
      onSubmit={submit}
      data-testid="agent-reset-form"
    >
      <div>
        <label className="label" htmlFor="agent-reset-password">
          Choose a new password
        </label>
        <input
          className="input"
          id="agent-reset-password"
          data-testid="agent-reset-password"
          type="password"
          minLength={10}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate">{passwordHelp}</p>
      </div>
      <div>
        <label className="label" htmlFor="agent-reset-confirm">
          Type it again
        </label>
        <input
          className="input"
          id="agent-reset-confirm"
          data-testid="agent-reset-confirm"
          type="password"
          minLength={10}
          maxLength={128}
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      <Message error={error} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="agent-reset-submit"
      >
        {busy ? "Saving…" : "Set new password and sign in"}
      </button>
    </form>
  );
}

export function AgentLogoutButton({ draftId }: { draftId: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function logout() {
    setBusy(true);
    try {
      await apiMutation(
        `/api/a/${encodeURIComponent(draftId)}/auth/logout`,
        {},
      );
      router.push(`/a/${encodeURIComponent(draftId)}/login`);
      router.refresh();
    } catch {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="btn-quiet text-xs"
      disabled={busy}
      onClick={() => void logout()}
    >
      {busy ? "Signing out…" : "Logout"}
    </button>
  );
}
