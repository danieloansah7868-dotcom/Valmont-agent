"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiMutation, ApiError } from "@/lib/client-api";

/**
 * Client forms for the shop admin side (Stage 6b). They talk only to
 * `/api/manage/[id]/auth/*` and know nothing about Studio or customer
 * accounts. Every form posts JSON through `apiMutation`, which attaches the
 * CSRF header the server insists on.
 */

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "We could not complete that request. Please try again.";
}

function FormMessage({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return (
    <p
      className={`rounded-lg px-3 py-2 text-sm ${
        error
          ? "bg-fail-soft text-fail-strong"
          : "bg-pass-soft text-pass-strong"
      }`}
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
      data-testid={error ? "shop-form-error" : "shop-form-success"}
    >
      {error || success}
    </p>
  );
}

const PASSWORD_HELP = "At least 10 characters.";

export function ShopLoginForm({
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
  const base = `/manage/${encodeURIComponent(draftId)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await apiMutation<{ ok: true; next: string }>(
        `/api/manage/${encodeURIComponent(draftId)}/auth/login`,
        { email, password, next },
      );
      // The header is a server layout that reads the new cookie, so the
      // navigation is followed by a refresh to re-render it signed in.
      router.push(result.next || base);
      router.refresh();
    } catch (requestError) {
      setError(errorMessage(requestError));
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={submit}
      data-testid="shop-login-form"
    >
      <div>
        <label className="label" htmlFor="shop-login-email">
          Email address
        </label>
        <input
          className="input"
          id="shop-login-email"
          data-testid="shop-login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <div className="flex items-center justify-between gap-3">
          <label className="label mb-0" htmlFor="shop-login-password">
            Password
          </label>
          <Link
            href={`${base}/forgot-password`}
            className="text-xs font-semibold text-copper-700 hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <input
          className="input mt-2"
          id="shop-login-password"
          data-testid="shop-login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <FormMessage error={error} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="shop-login-submit"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function ShopAcceptInviteForm({
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
  const base = `/manage/${encodeURIComponent(draftId)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await apiMutation<{ ok: true }>(
        `/api/manage/${encodeURIComponent(draftId)}/auth/accept-invite`,
        { token, name, password },
      );
      router.push(base);
      router.refresh();
    } catch (requestError) {
      setError(errorMessage(requestError));
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={submit}
      data-testid="shop-accept-invite-form"
    >
      <div>
        <label className="label" htmlFor="shop-accept-name">
          Your name
        </label>
        <input
          className="input"
          id="shop-accept-name"
          data-testid="shop-accept-name"
          type="text"
          autoComplete="name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="shop-accept-password">
          Choose a password
        </label>
        <input
          className="input"
          id="shop-accept-password"
          data-testid="shop-accept-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate">{PASSWORD_HELP}</p>
      </div>
      <div>
        <label className="label" htmlFor="shop-accept-confirm">
          Type it again
        </label>
        <input
          className="input"
          id="shop-accept-confirm"
          data-testid="shop-accept-confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      <FormMessage error={error} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="shop-accept-submit"
      >
        {busy ? "Saving…" : "Set password and sign in"}
      </button>
    </form>
  );
}

export function ShopForgotPasswordForm({ draftId }: { draftId: string }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const result = await apiMutation<{ ok: true; message: string }>(
        `/api/manage/${encodeURIComponent(draftId)}/auth/forgot-password`,
        { email },
      );
      setSuccess(result.message);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="shop-forgot-email">
          Email address
        </label>
        <input
          className="input"
          id="shop-forgot-email"
          data-testid="shop-forgot-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <FormMessage error={error} success={success} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="shop-forgot-submit"
      >
        {busy ? "Sending…" : "Send me a link"}
      </button>
    </form>
  );
}

export function ShopResetPasswordForm({
  draftId,
  token,
}: {
  draftId: string;
  token: string;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/manage/${encodeURIComponent(draftId)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await apiMutation<{ ok: true }>(
        `/api/manage/${encodeURIComponent(draftId)}/auth/reset-password`,
        { token, password },
      );
      setDone(true);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <FormMessage success="Your password has been changed. Sign in with the new one." />
        <Link href={`${base}/login`} className="btn-primary w-full">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="shop-reset-password">
          New password
        </label>
        <input
          className="input"
          id="shop-reset-password"
          data-testid="shop-reset-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate">{PASSWORD_HELP}</p>
      </div>
      <div>
        <label className="label" htmlFor="shop-reset-confirm">
          Type it again
        </label>
        <input
          className="input"
          id="shop-reset-confirm"
          data-testid="shop-reset-confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      <FormMessage error={error} />
      <button
        className="btn-primary w-full"
        disabled={busy}
        type="submit"
        data-testid="shop-reset-submit"
      >
        {busy ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}

export function ShopLogoutButton({ draftId }: { draftId: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const base = `/manage/${encodeURIComponent(draftId)}`;

  async function logout() {
    setBusy(true);
    try {
      await apiMutation<{ ok: true }>(
        `/api/manage/${encodeURIComponent(draftId)}/auth/logout`,
        {},
      );
      router.push(`${base}/login`);
      router.refresh();
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      className="btn-secondary text-sm"
      disabled={busy}
      onClick={logout}
      type="button"
      data-testid="shop-logout"
    >
      {busy ? "Signing out…" : "Logout"}
    </button>
  );
}
