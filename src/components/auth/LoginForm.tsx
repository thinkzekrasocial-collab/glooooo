"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiClientError, apiFetch, setLegacyBearerToken } from "@/lib/api-client";

type SandboxAccount = { email: string; name: string; role: string; label: string; password?: string };

const FEEDBACK: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: "Invalid email or password.",
  AUTH_ACCOUNT_LOCKED: "Too many failed attempts. This account is temporarily locked.",
  AUTH_ACCOUNT_PENDING: "This account is provisioned but not activated yet. Ask an administrator.",
  AUTH_ACCOUNT_SUSPENDED: "This account is suspended. Contact student services.",
  AUTH_ACCOUNT_INACTIVE: "This account is no longer active.",
  AUTH_MFA_INVALID: "That verification code is not valid.",
  RATE_LIMIT_EXCEEDED: "Too many attempts. Please wait a moment and try again.",
};

export function LoginForm({
  sandboxAccounts,
  sandboxPassword,
}: {
  sandboxAccounts: SandboxAccount[];
  sandboxPassword: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSandbox, setShowSandbox] = useState(true);

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const submittedEmail = String(form.get("email") ?? email).trim();
      const submittedPassword = String(form.get("password") ?? password);
      if (!submittedEmail || !submittedPassword) {
        setError("Enter your email and password.");
        return;
      }
      const result = await apiFetch<{ mfaRequired: boolean; next: string; token?: string }>("/api/auth/login", {
        method: "POST",
        body: { email: submittedEmail, password: submittedPassword },
      });
      // Older deployed Workers return a bearer token and reject their cookie;
      // newer deployments use the httpOnly cookie and omit this field.
      setLegacyBearerToken(result.token ?? null);
      if (result.mfaRequired) {
        setMfaRequired(true);
        return;
      }
      router.replace("/app");
    } catch (caught) {
      const message =
        caught instanceof ApiClientError
          ? FEEDBACK[caught.code] ?? caught.message
          : "Sign-in failed. Please try again.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/auth/mfa", { method: "POST", body: { code } });
      router.replace("/app");
    } catch (caught) {
      const message =
        caught instanceof ApiClientError ? FEEDBACK[caught.code] ?? caught.message : "Verification failed.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      ) : null}

      {!mfaRequired ? (
          <form action="/login/submit" method="post" onSubmit={submitCredentials} className="panel space-y-4 p-5" noValidate>
          <div>
            <label className="label" htmlFor="email">
              School email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              className="field"
              placeholder="you@globebridge.edu"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="field"
              placeholder="••••••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Verifying…" : "Sign in"}
          </button>
          <p className="text-center text-xs text-slate-500">
            Locked out or need an account? Contact the GlobeBridge student services desk — they
            provision accounts and issue onboarding invitations.
          </p>
        </form>
      ) : (
        <form method="post" onSubmit={submitMfa} className="panel space-y-4 p-5" noValidate>
          <div>
            <label className="label" htmlFor="code">
              Six-digit code from your authenticator app
            </label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              className="field tracking-[0.5em]"
              placeholder="000000"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Verify and continue"}
          </button>
          <button
            type="button"
            className="btn-quiet w-full"
            onClick={() => {
              setMfaRequired(false);
              setCode("");
            }}
          >
            Use a different account
          </button>
        </form>
      )}

      {sandboxAccounts.length > 0 ? <div className="mt-4 panel-soft p-4">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-wide text-slate-400"
          onClick={() => setShowSandbox((value) => !value)}
          aria-expanded={showSandbox}
        >
          Sandbox demo accounts
          <span aria-hidden>{showSandbox ? "−" : "+"}</span>
        </button>
        {showSandbox ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-slate-500">
              Seeded locally through the admin provisioning path. Production deployments never publish
              credentials and always require MFA for administrators.
            </p>
            {sandboxAccounts.map((account) => (
              <button
                key={account.email}
                type="button"
                className="flex w-full flex-col rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/[0.06]"
                onClick={() => {
                  setEmail(account.email);
                  setPassword(account.password ?? sandboxPassword);
                  setMfaRequired(false);
                }}
              >
                <span className="text-sm text-slate-100">{account.name}</span>
                <span className="text-xs text-slate-500">
                  {account.email} · {account.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div> : null}
    </div>
  );
}
