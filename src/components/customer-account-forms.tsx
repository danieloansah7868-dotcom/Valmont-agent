"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiMutation, ApiError } from "@/lib/client-api";

interface AuthSuccess {
  ok: true;
  message: string;
  next?: string;
  verificationLink?: string;
  resetLink?: string;
}

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
      role="status"
      aria-live="polite"
    >
      {error || success}
    </p>
  );
}

export function LoginForm({ next = "/account" }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await apiMutation<AuthSuccess>(
        "/api/customer/auth/login",
        {
          email,
          password,
          next,
        },
      );
      window.location.assign(result.next || "/account");
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="customer-login-email">
          Email address
        </label>
        <input
          className="input"
          id="customer-login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <div className="flex items-center justify-between gap-3">
          <label className="label mb-0" htmlFor="customer-login-password">
            Password
          </label>
          <Link
            href="/account/forgot-password"
            className="text-xs font-semibold text-copper-700 hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <input
          className="input mt-2"
          id="customer-login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <FormMessage error={error} />
      <button className="btn-primary w-full" disabled={busy} type="submit">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function ResendVerificationForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<AuthSuccess | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess(null);
    setBusy(true);
    try {
      const result = await apiMutation<AuthSuccess>(
        "/api/customer/auth/resend-verification",
        { email },
      );
      setSuccess(result);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={submit}>
        <label className="sr-only" htmlFor="customer-resend-email">
          Email address
        </label>
        <input
          className="input"
          id="customer-resend-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className="btn-secondary" disabled={busy} type="submit">
          {busy ? "Sending…" : "Resend"}
        </button>
      </form>
      <FormMessage error={error} success={success?.message} />
      {success?.verificationLink ? (
        <a
          className="break-all text-xs font-semibold text-copper-700 hover:underline"
          href={success.verificationLink}
        >
          Open local verification link
        </a>
      ) : null}
    </div>
  );
}

export function RegisterForm({
  claimAccessCode,
}: {
  claimAccessCode?: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<AuthSuccess | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess(null);
    setBusy(true);
    try {
      const result = await apiMutation<AuthSuccess>(
        "/api/customer/auth/register",
        {
          name,
          email,
          password,
          ...(claimAccessCode ? { claimAccessCode } : {}),
        },
      );
      setPassword("");
      setSuccess(result);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div className="grid gap-4">
        <FormMessage success={success.message} />
        {success.verificationLink ? (
          <div className="rounded-lg border border-dashed border-copper-300 bg-copper-50 p-3 text-sm text-navy">
            <p className="font-semibold">Local development shortcut</p>
            <p className="mt-1 text-slate">
              No email provider is configured, so you can use this one-time
              verification link locally:
            </p>
            <a
              className="mt-2 block break-all font-semibold text-copper-700 hover:underline"
              href={success.verificationLink}
            >
              Verify this email address
            </a>
          </div>
        ) : null}
        <Link className="btn-secondary w-full" href="/account/login">
          Continue to sign in
        </Link>
      </div>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="customer-register-name">
          Your name
        </label>
        <input
          className="input"
          id="customer-register-name"
          type="text"
          autoComplete="name"
          minLength={2}
          maxLength={80}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="customer-register-email">
          Email address
        </label>
        <input
          className="input"
          id="customer-register-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="customer-register-password">
          Password
        </label>
        <input
          className="input"
          id="customer-register-password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate">Use at least 10 characters.</p>
      </div>
      {claimAccessCode ? (
        <p className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success-strong">
          Your completed order will be linked to this account after you finish
          registration.
        </p>
      ) : null}
      <FormMessage error={error} />
      <button className="btn-primary w-full" disabled={busy} type="submit">
        {busy ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<AuthSuccess | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess(null);
    setBusy(true);
    try {
      const result = await apiMutation<AuthSuccess>(
        "/api/customer/auth/forgot-password",
        { email },
      );
      setSuccess(result);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <form className="grid gap-4" onSubmit={submit}>
        <div>
          <label className="label" htmlFor="customer-forgot-email">
            Email address
          </label>
          <input
            className="input"
            id="customer-forgot-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <FormMessage error={error} />
        <button className="btn-primary w-full" disabled={busy} type="submit">
          {busy ? "Sending instructions…" : "Send reset instructions"}
        </button>
      </form>
      {success ? (
        <>
          <FormMessage success={success.message} />
          {success.resetLink ? (
            <div className="rounded-lg border border-dashed border-copper-300 bg-copper-50 p-3 text-sm text-navy">
              <p className="font-semibold">Local development shortcut</p>
              <a
                className="mt-2 block break-all font-semibold text-copper-700 hover:underline"
                href={success.resetLink}
              >
                Open password reset link
              </a>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await apiMutation<AuthSuccess>(
        "/api/customer/auth/reset-password",
        { token, password },
      );
      setSuccess(result.message);
      setPassword("");
      setConfirm("");
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div className="grid gap-4">
        <FormMessage success={success} />
        <Link className="btn-primary w-full" href="/account/login">
          Sign in with your new password
        </Link>
      </div>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="customer-reset-password">
          New password
        </label>
        <input
          className="input"
          id="customer-reset-password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="customer-reset-confirm">
          Confirm new password
        </label>
        <input
          className="input"
          id="customer-reset-confirm"
          type="password"
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      <FormMessage error={error} />
      <button className="btn-primary w-full" disabled={busy} type="submit">
        {busy ? "Updating password…" : "Update password"}
      </button>
    </form>
  );
}

export function ClaimOrderButton({ accessCode }: { accessCode: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function claim() {
    setError("");
    setBusy(true);
    try {
      await apiMutation<{ ok: true }>("/api/customer/orders/claim", {
        accessCode,
      });
      router.push("/account");
    } catch (requestError) {
      setError(errorMessage(requestError));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        className="btn-primary"
        disabled={busy}
        onClick={claim}
        type="button"
      >
        {busy ? "Linking order…" : "Link this order to my account"}
      </button>
      {error ? (
        <p className="mt-2 text-sm text-fail-strong" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CustomerLogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      await apiMutation<{ ok: true }>("/api/customer/auth/logout", {});
      router.push("/");
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      className="btn-secondary"
      disabled={busy}
      onClick={logout}
      type="button"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
