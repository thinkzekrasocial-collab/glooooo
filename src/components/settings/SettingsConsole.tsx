"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClientError, apiFetch, formatRelativeTime } from "@/lib/api-client";

type Me = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  phoneNumber: string | null;
  campusLocation: string | null;
  dateOfBirth: string | null;
  userType: string;
  status: string;
  studentId: string | null;
  employeeId: string | null;
  department: string | null;
  gradeClass: string | null;
  program: string | null;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  roles: string[];
  lastLoginAt: string | null;
};

type Initial = {
  preferences: { notifications: Record<string, boolean>; privacy: Record<string, boolean>; theme: string };
  sessions: Array<{
    id: string;
    current: boolean;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
  }>;
  devices: Array<{
    id: string;
    current: boolean;
    deviceName: string;
    browserInfo: string | null;
    status: string;
    lastActiveAt: string | null;
  }>;
  groups: Array<{ id: string; name: string; groupType: string; memberRole: string; memberCount: number }>;
  reports: Array<{ id: string; reason: string; status: string; createdAt: string; resolutionNotes: string | null }>;
};

const NOTIFICATION_LABELS: Record<string, string> = {
  directMessages: "Direct messages",
  groupMessages: "Group messages",
  mentions: "Mentions",
  securityAlerts: "Security alerts",
  pushEnabled: "Web push (VAPID)",
  emailEnabled: "Email digests",
};

const PRIVACY_LABELS: Record<string, string> = {
  readReceipts: "Send read receipts",
  typingIndicators: "Share typing indicators",
  onlineStatus: "Show online presence",
};

export function SettingsConsole({ me, initial }: { me: Me; initial: Initial }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [preferences, setPreferences] = useState(initial.preferences);
  const [sessions, setSessions] = useState(initial.sessions);
  const [devices, setDevices] = useState(initial.devices);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 lg:p-6">
      <header>
        <h1 className="text-xl font-semibold text-white">Settings</h1>
        <p className="text-sm text-slate-400">
          Self-service changes are limited by policy. Contact an administrator for directory details,
          roles or account status.
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </p>
      ) : null}

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">Identity</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Name</dt>
            <dd className="text-slate-200">
              {me.firstName} {me.lastName}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Email (admin controlled)</dt>
            <dd className="text-slate-200">{me.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Account type</dt>
            <dd className="text-slate-200">
              {me.userType} · {me.status}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Roles</dt>
            <dd className="text-slate-200">{me.roles.join(", ") || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Department / grade</dt>
            <dd className="text-slate-200">{me.department ?? me.gradeClass ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Last sign-in</dt>
            <dd className="text-slate-200">{me.lastLoginAt ? new Date(me.lastLoginAt).toLocaleString() : "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">Profile details you can edit</h2>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(async () => {
              await apiFetch("/api/users/me", {
                method: "PATCH",
                body: {
                  preferredName: String(form.get("preferredName") ?? "") || undefined,
                  phoneNumber: String(form.get("phoneNumber") ?? "") || undefined,
                  campusLocation: String(form.get("campusLocation") ?? "") || undefined,
                  dateOfBirth: String(form.get("dateOfBirth") ?? "") || undefined,
                },
              });
              setNotice("Profile updated.");
              router.refresh();
            });
          }}
        >
          <div>
            <label className="label" htmlFor="preferredName">
              Preferred name
            </label>
            <input id="preferredName" name="preferredName" className="field" defaultValue={me.preferredName ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="phoneNumber">
              Mobile number
            </label>
            <input id="phoneNumber" name="phoneNumber" className="field" defaultValue={me.phoneNumber ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="campusLocation">
              Campus location
            </label>
            <input id="campusLocation" name="campusLocation" className="field" defaultValue={me.campusLocation ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="dateOfBirth">
              Date of birth
            </label>
            <input id="dateOfBirth" name="dateOfBirth" type="date" className="field" defaultValue={me.dateOfBirth ?? ""} />
          </div>
          <button type="submit" className="btn-primary sm:col-span-2" disabled={busy}>
            Save profile
          </button>
        </form>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">Password</h2>
        <p className="mt-1 text-xs text-slate-500">
          Minimum 12 characters with upper case, lower case, a number and a symbol. Changing your
          password signs out every other session.
        </p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(async () => {
              const result = await apiFetch<{ revokedSessions: number }>("/api/users/me/password", {
                method: "POST",
                body: {
                  currentPassword: String(form.get("currentPassword") ?? ""),
                  newPassword: String(form.get("newPassword") ?? ""),
                  confirmPassword: String(form.get("confirmPassword") ?? ""),
                },
              });
              setNotice(`Password changed. ${result.revokedSessions} other session(s) revoked.`);
              event.currentTarget.reset();
            });
          }}
        >
          <div>
            <label className="label" htmlFor="currentPassword">
              Current password
            </label>
            <input id="currentPassword" name="currentPassword" type="password" className="field" required />
          </div>
          <div>
            <label className="label" htmlFor="newPassword">
              New password
            </label>
            <input id="newPassword" name="newPassword" type="password" className="field" required />
          </div>
          <div>
            <label className="label" htmlFor="confirmPassword">
              Confirm
            </label>
            <input id="confirmPassword" name="confirmPassword" type="password" className="field" required />
          </div>
          <button type="submit" className="btn-primary sm:col-span-3" disabled={busy}>
            Change password
          </button>
        </form>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">Multi-factor authentication (TOTP)</h2>
        <p className="mt-1 text-xs text-slate-500">
          {me.mfaEnabled
            ? "MFA is enabled — sign-in requires a six-digit code."
            : me.mfaRequired
              ? "Policy requires MFA on this account. Enrol to keep access."
              : "Optional for your account type, recommended for staff."}
        </p>

        {!me.mfaEnabled ? (
          <div className="mt-3 space-y-3">
            {!enrollment ? (
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const payload = await apiFetch<{ secret: string; otpauthUrl: string }>("/api/users/me/mfa", {
                      method: "POST",
                      body: { action: "enroll" },
                    });
                    setEnrollment(payload);
                  })
                }
              >
                Start enrolment
              </button>
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border border-white/10 bg-black/30 p-3 text-xs">
                  <p className="text-slate-400">Add to your authenticator app (or paste the secret):</p>
                  <code className="mt-1 block break-all text-[color:var(--color-mint-400)]">{enrollment.secret}</code>
                  <a
                    className="mt-2 inline-block break-all text-[color:var(--color-glow-400)] hover:underline"
                    href={enrollment.otpauthUrl}
                  >
                    {enrollment.otpauthUrl}
                  </a>
                </div>
                <div className="flex gap-2">
                  <input
                    className="field max-w-[160px] tracking-[0.4em]"
                    placeholder="000000"
                    inputMode="numeric"
                    maxLength={6}
                    value={mfaCode}
                    onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ""))}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy || mfaCode.length !== 6}
                    onClick={() =>
                      void run(async () => {
                        await apiFetch("/api/users/me/mfa", {
                          method: "POST",
                          body: { action: "verify", code: mfaCode },
                        });
                        setNotice("MFA enabled. You will be asked for a code at each sign-in.");
                        setEnrollment(null);
                        setMfaCode("");
                        router.refresh();
                      })
                    }
                  >
                    Confirm code
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void run(async () => {
                await apiFetch("/api/users/me/mfa", {
                  method: "POST",
                  body: { action: "disable", password: String(form.get("password") ?? "") },
                });
                setNotice("MFA disabled.");
                router.refresh();
              });
            }}
          >
            <div>
              <label className="label" htmlFor="mfa-password">
                Confirm password to disable
              </label>
              <input id="mfa-password" name="password" type="password" className="field" required disabled={me.mfaRequired} />
            </div>
            <button type="submit" className="btn-danger" disabled={busy || me.mfaRequired}>
              Disable MFA
            </button>
            {me.mfaRequired ? (
              <p className="text-xs text-amber-200">Policy requires MFA — an administrator must clear the flag.</p>
            ) : null}
          </form>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">Notifications &amp; privacy</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notifications</p>
            <div className="mt-2 space-y-2">
              {Object.entries(preferences.notifications).map(([key, value]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={Boolean(value)}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        notifications: { ...preferences.notifications, [key]: event.target.checked },
                      })
                    }
                  />
                  {NOTIFICATION_LABELS[key] ?? key}
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Privacy</p>
            <div className="mt-2 space-y-2">
              {Object.entries(preferences.privacy)
                .filter(([key]) => key in PRIVACY_LABELS)
                .map(([key, value]) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={Boolean(value)}
                      onChange={(event) =>
                        setPreferences({
                          ...preferences,
                          privacy: { ...preferences.privacy, [key]: event.target.checked },
                        })
                      }
                    />
                    {PRIVACY_LABELS[key] ?? key}
                  </label>
                ))}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn-primary mt-4"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await apiFetch("/api/users/me/preferences", {
                method: "PUT",
                body: { notifications: preferences.notifications, privacy: preferences.privacy, theme: preferences.theme },
              });
              setNotice("Preferences saved.");
            })
          }
        >
          Save preferences
        </button>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">Sessions</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {sessions.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
              <span>
                <span className="text-slate-200">
                  {row.current ? "This session" : "Session"} · {row.ipAddress ?? "unknown IP"}
                </span>
                <span className="block text-xs text-slate-500">
                  started {formatRelativeTime(row.createdAt)} · last used {formatRelativeTime(row.lastUsedAt)} ·
                  expires {new Date(row.expiresAt).toLocaleTimeString()}
                </span>
              </span>
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={busy || row.current}
                onClick={() =>
                  void run(async () => {
                    await apiFetch("/api/users/me/security", {
                      method: "POST",
                      body: { action: "revoke_session", sessionId: row.id },
                    });
                    setSessions((previous) => previous.filter((session) => session.id !== row.id));
                    setNotice("Session revoked.");
                  })
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn-danger mt-3"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await apiFetch("/api/users/me/security", { method: "POST", body: { action: "revoke_other_sessions" } });
              setSessions((previous) => previous.filter((session) => session.current));
              setNotice("All other sessions were signed out.");
            })
          }
        >
          Sign out other sessions
        </button>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">Devices &amp; encryption keys</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
              <span>
                <span className="text-slate-200">
                  {device.deviceName} {device.current ? <span className="chip-ok">this browser</span> : null}
                </span>
                <span className="block text-xs text-slate-500">
                  {device.browserInfo ?? "unknown agent"} · last active {formatRelativeTime(device.lastActiveAt)} ·{" "}
                  {device.status}
                </span>
              </span>
              <button
                type="button"
                className="btn-danger text-xs"
                disabled={busy || device.current}
                onClick={() =>
                  void run(async () => {
                    await apiFetch("/api/users/me/security", {
                      method: "POST",
                      body: { action: "revoke_device", deviceId: device.id },
                    });
                    setDevices((previous) =>
                      previous.map((item) => (item.id === device.id ? { ...item, status: "revoked" } : item)),
                    );
                    setNotice("Device revoked and its wrapped keys are no longer served.");
                  })
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">My groups</h2>
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {initial.groups.length === 0 ? (
            <li className="text-slate-500">No group memberships.</li>
          ) : (
            initial.groups.map((group) => (
              <li key={group.id} className="chip">
                {group.name} · {group.memberRole} · {group.memberCount} members
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">My reports</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {initial.reports.length === 0 ? (
            <li className="text-slate-500">You have not submitted any reports.</li>
          ) : (
            initial.reports.map((report) => (
              <li key={report.id} className="border-b border-white/5 pb-2">
                <span className="text-slate-200">{report.reason}</span>{" "}
                <span className={report.status === "resolved" ? "chip-ok" : "chip-warn"}>{report.status}</span>
                <span className="mt-1 block text-xs text-slate-500">
                  {new Date(report.createdAt).toLocaleString()}
                  {report.resolutionNotes ? ` · ${report.resolutionNotes}` : ""}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold text-white">What the platform can and cannot see</h2>
        <ul className="mt-2 space-y-1 text-xs text-slate-400">
          <li>• Message bodies, attachments and file names: encrypted in this browser; the server stores ciphertext only.</li>
          <li>• Metadata the server stores: participants, timestamps, delivery/read state, channel policy.</li>
          <li>• Your identity private key is non-extractable and never transmitted; revoking a device removes its wrapped conversation keys.</li>
          <li>• Administrators can see audit events, security events and only the report excerpts you volunteer.</li>
        </ul>
      </section>
    </div>
  );
}
