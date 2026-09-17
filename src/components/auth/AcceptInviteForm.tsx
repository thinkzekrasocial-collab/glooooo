"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClientError, apiFetch } from "@/lib/api-client";

type InvitationInfo = {
  email: string;
  firstName: string;
  lastName: string;
  userType: string;
  expiresAt: string;
  invitedBy: string;
  passwordPolicy: string;
};

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<InvitationInfo>(`/api/invitations/${encodeURIComponent(token)}`)
      .then((payload) => {
        if (cancelled) return;
        setInfo(payload);
        setFirstName(payload.firstName);
        setLastName(payload.lastName);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setLoadError(
          caught instanceof ApiClientError
            ? caught.message
            : "This onboarding link could not be read.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/invitations/${encodeURIComponent(token)}`, {
        method: "POST",
        body: { firstName, lastName, phoneNumber, password, confirmPassword },
      });
      router.replace("/app");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiClientError ? caught.message : "The account could not be activated.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="panel p-6">
        <h2 className="text-base font-semibold text-rose-200">Invitation unavailable</h2>
        <p className="mt-2 text-sm text-slate-400">{loadError}</p>
        <p className="mt-3 text-xs text-slate-500">
          Onboarding links are single-use and expire. Ask an administrator to issue a new invitation
          from the admin console.
        </p>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="panel animate-pulse p-6">
        <div className="h-4 w-40 rounded bg-white/10" />
        <div className="mt-3 h-4 w-64 rounded bg-white/10" />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel space-y-4 p-6" noValidate>
      <div className="panel-soft p-3 text-xs text-slate-400">
        <p>
          Invited by <strong className="text-slate-200">{info.invitedBy}</strong> as{" "}
          <span className="chip-info">{info.userType}</span>
        </p>
        <p className="mt-1">
          {info.email} · link expires {new Date(info.expiresAt).toLocaleString()}
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="firstName">
            First name
          </label>
          <input id="firstName" className="field" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="lastName">
            Last name
          </label>
          <input id="lastName" className="field" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="phoneNumber">
          Mobile (optional, for account recovery)
        </label>
        <input id="phoneNumber" className="field" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="password">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="confirmPassword">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            className="field"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
      </div>

      <p className="text-xs text-slate-500">{info.passwordPolicy}</p>

      <button type="submit" className="btn-primary w-full" disabled={busy || !password}>
        {busy ? "Activating…" : "Activate account"}
      </button>
    </form>
  );
}
