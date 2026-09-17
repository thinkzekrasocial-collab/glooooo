"use client";

import { useCallback, useMemo, useState } from "react";
import { ApiClientError, apiFetch, formatRelativeTime } from "@/lib/api-client";

/* ── types mirrored from the server data layer ── */
type AdminUser = {
  id: string;
  email: string;
  name: string;
  userType: string;
  status: string;
  department: string | null;
  gradeClass: string | null;
  program: string | null;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  roleNames: string[];
  deviceCount: number;
  lockedUntil: string | null;
};

type AdminGroup = {
  id: string;
  name: string;
  description: string | null;
  groupType: string;
  status: string;
  visibility: string;
  maxMembers: number | null;
  announcementOnly: boolean;
  retentionPolicyDays: number | null;
  fileSharingEnabled: boolean;
  memberCount: number;
  conversationCount: number;
};

type RoleRow = { id: string; name: string; description: string | null; permissions: unknown };

type AuditRow = {
  id: string;
  eventType: string;
  action: string;
  actorName: string | null;
  actorId: string;
  actorRole: string | null;
  targetType: string | null;
  targetId: string | null;
  result: string;
  ipAddress: string | null;
  createdAt: string;
};

type SecurityRow = {
  id: string;
  eventType: string;
  severity: string;
  userId: string | null;
  userName: string | null;
  ipAddress: string | null;
  createdAt: string;
};

type ReportRow = {
  id: string;
  reporterName: string | null;
  targetType: string;
  targetId: string;
  reason: string;
  description: string | null;
  submittedContent: string | null;
  status: string;
  resolutionNotes: string | null;
  createdAt: string;
};

type InvitationRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  userType: string;
  roleName: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
};

type SettingRow = { key: string; value: unknown; description: string | null; updatedAt: string };

type Overview = {
  users: Record<string, number>;
  groups: Record<string, number>;
  reports: Record<string, number>;
  conversations: number;
  messages: number;
  messageTypes: Array<{ contentType: string; count: number }>;
  recentAudit: Array<{
    id: string;
    eventType: string;
    action: string;
    actorId: string;
    actorName: string | null;
    result: string;
    createdAt: string;
  }>;
  recentSecurity: Array<{ id: string; eventType: string; severity: string; createdAt: string }>;
};

type InitialData = {
  overview: Overview | null;
  users: AdminUser[];
  groups: AdminGroup[];
  roles: RoleRow[];
  audit: AuditRow[];
  security: SecurityRow[];
  reports: ReportRow[];
  invitations: InvitationRow[];
  settings: SettingRow[];
};

const TABS = [
  { id: "overview", label: "Overview", permission: "users.view" },
  { id: "users", label: "Accounts", permission: "users.view" },
  { id: "groups", label: "Groups", permission: "groups.view" },
  { id: "invitations", label: "Invitations", permission: "invitations.manage" },
  { id: "reports", label: "Reports", permission: "reports.view" },
  { id: "audit", label: "Audit trail", permission: "audit.view" },
  { id: "security", label: "Security events", permission: "security.view" },
  { id: "settings", label: "Platform policy", permission: "users.view" },
] as const;

function can(permissions: string[], required: string) {
  return permissions.includes("*") || permissions.includes(required);
}

export function AdminConsole({
  me,
  initial,
}: {
  me: { id: string; name: string; permissions: string[]; roles: string[] };
  initial: InitialData;
}) {
  const tabs = useMemo(
    () => TABS.filter((tab) => can(me.permissions, tab.permission)),
    [me.permissions],
  );
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>(tabs[0]?.id ?? "overview");
  const [data, setData] = useState<InitialData>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userFilter, setUserFilter] = useState({ q: "", status: "", userType: "" });
  const [groupMemberView, setGroupMemberView] = useState<string | null>(null);
  const [groupMembers, setGroupMembers] = useState<Array<{ userId: string; name: string; email: string; memberRole: string }>>([]);
  const [expandedUser, setExpandedUser] = useState<AdminUser | null>(null);
  const [issuedInvite, setIssuedInvite] = useState<{ onboardingUrl: string; email: string } | null>(null);
  const [policyDraft, setPolicyDraft] = useState<Record<string, unknown>>(
    Object.fromEntries(initial.settings.map((setting) => [setting.key, setting.value])),
  );

  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshUsers = useCallback(async () => {
    const params = new URLSearchParams();
    if (userFilter.q) params.set("q", userFilter.q);
    if (userFilter.status) params.set("status", userFilter.status);
    if (userFilter.userType) params.set("userType", userFilter.userType);
    const payload = await apiFetch<{ users: AdminUser[] }>(`/api/admin/users?${params.toString()}`);
    setData((previous) => ({ ...previous, users: payload.users }));
  }, [userFilter]);

  const refreshGroups = useCallback(async () => {
    const payload = await apiFetch<{ groups: AdminGroup[] }>("/api/admin/groups");
    setData((previous) => ({ ...previous, groups: payload.groups }));
  }, []);

  const refreshAudit = useCallback(async () => {
    const payload = await apiFetch<{ logs: AuditRow[] }>("/api/admin/audit?limit=120");
    setData((previous) => ({ ...previous, audit: payload.logs }));
    const overview = await apiFetch<Overview>("/api/admin/overview");
    setData((previous) => ({ ...previous, overview }));
  }, []);

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Admin control plane</h1>
          <p className="text-sm text-slate-400">
            Provision accounts, groups and invitations. Administrators can never read message
            plaintext — only metadata, policy and voluntarily submitted excerpts.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {me.roles.map((role) => (
            <span key={role} className="chip-info">
              {role.replace("_", " ")}
            </span>
          ))}
        </div>
      </header>

      <nav className="flex flex-wrap gap-1" aria-label="Admin sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "tab-active" : "tab"}
            aria-current={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

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
      {issuedInvite ? (
        <div className="panel p-4 text-sm">
          <p className="font-semibold text-white">Onboarding link issued for {issuedInvite.email}</p>
          <p className="mt-1 text-xs text-slate-400">
            Shown once. Deliver out-of-band — only its SHA-256 hash is stored.
          </p>
          <code className="mt-2 block overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-[color:var(--color-mint-400)]">
            {issuedInvite.onboardingUrl}
          </code>
        </div>
      ) : null}

      {/* ───────────── overview ───────────── */}
      {tab === "overview" && data.overview ? (
        <section className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Active accounts", value: data.overview.users.active ?? 0 },
              { label: "Pending activation", value: data.overview.users.pending ?? 0 },
              { label: "Suspended", value: data.overview.users.suspended ?? 0 },
              { label: "Open reports", value: data.overview.reports.pending ?? 0 },
              { label: "Active channels", value: data.overview.conversations },
              { label: "Messages stored (ciphertext)", value: data.overview.messages },
              { label: "Groups", value: Object.values(data.overview.groups).reduce((a, b) => a + b, 0) },
              { label: "Draft groups", value: data.overview.groups.draft ?? 0 },
            ].map((card) => (
              <div key={card.label} className="panel p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">{card.label}</p>
                <p className="mt-1 text-2xl font-semibold text-white">{card.value}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="panel p-4">
              <h2 className="text-sm font-semibold text-white">Latest admin actions</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {data.overview.recentAudit.map((row) => (
                  <li key={row.id} className="flex items-start justify-between gap-3 border-b border-white/5 pb-2">
                    <span>
                      <span className="font-medium text-slate-200">{row.eventType}</span>
                      <span className="block text-xs text-slate-500">
                        {row.actorName ?? "system"} · {row.action}
                      </span>
                    </span>
                    <span className={row.result === "success" ? "chip-ok" : "chip-danger"}>{row.result}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="panel p-4">
              <h2 className="text-sm font-semibold text-white">Recent security events</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {data.overview.recentSecurity.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 border-b border-white/5 pb-2">
                    <span className="text-slate-200">{row.eventType}</span>
                    <span
                      className={
                        row.severity === "critical" ? "chip-danger" : row.severity === "warning" ? "chip-warn" : "chip"
                      }
                    >
                      {row.severity}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="panel p-4">
            <h2 className="text-sm font-semibold text-white">No-public-registration guarantees</h2>
            <ul className="mt-2 space-y-1 text-xs text-slate-400">
              <li>• No registration route exists in the router, and none is compiled into the client bundle.</li>
              <li>• <code>users.created_by_admin_id</code> is NOT NULL — every row references the administrator who created it.</li>
              <li>• Invitations are hashed, single-use and expire; revocation is audited.</li>
              <li>• Policy key <code>registration.public_signup_enabled</code> is locked to <code>false</code> by the API.</li>
            </ul>
          </div>
        </section>
      ) : null}

      {/* ───────────── users ───────────── */}
      {tab === "users" ? (
        <section className="space-y-4">
          <form
            className="panel grid gap-3 p-4 lg:grid-cols-5"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void run(async () => {
                const payload = await apiFetch<{
                  user: { id: string; email: string };
                  temporaryPassword?: string;
                  mustChangePassword: boolean;
                }>("/api/admin/users", {
                  method: "POST",
                  body: {
                    email: String(form.get("email") ?? ""),
                    firstName: String(form.get("firstName") ?? ""),
                    lastName: String(form.get("lastName") ?? ""),
                    userType: String(form.get("userType") ?? "student"),
                    department: String(form.get("department") ?? "") || undefined,
                    gradeClass: String(form.get("gradeClass") ?? "") || undefined,
                    status: String(form.get("status") ?? "pending"),
                    mfaRequired: form.get("mfaRequired") === "on",
                  },
                });
                setNotice(
                  payload.temporaryPassword
                    ? `Account created for ${payload.user.email}. Temporary password: ${payload.temporaryPassword}`
                    : `Account created for ${payload.user.email}.`,
                );
                event.currentTarget.reset();
                await refreshUsers();
                await refreshAudit();
              });
            }}
          >
            <div>
              <label className="label" htmlFor="new-email">
                Email
              </label>
              <input id="new-email" name="email" type="email" required className="field" />
            </div>
            <div>
              <label className="label" htmlFor="new-first">
                First name
              </label>
              <input id="new-first" name="firstName" required className="field" />
            </div>
            <div>
              <label className="label" htmlFor="new-last">
                Last name
              </label>
              <input id="new-last" name="lastName" required className="field" />
            </div>
            <div>
              <label className="label" htmlFor="new-type">
                Type
              </label>
              <select id="new-type" name="userType" className="field" defaultValue="student">
                {["student", "teacher", "staff", "mentor", "counselor", "parent", "admin"].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="new-status">
                Status
              </label>
              <select id="new-status" name="status" className="field" defaultValue="pending">
                <option value="pending">pending (admin activates)</option>
                <option value="active">active immediately</option>
              </select>
            </div>
            <div className="lg:col-span-2">
              <label className="label" htmlFor="new-dept">
                Department / grade
              </label>
              <input id="new-dept" name="department" className="field" />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-400 lg:col-span-2">
              <input type="checkbox" name="mfaRequired" className="h-4 w-4" /> Require TOTP MFA on this account
            </label>
            <button type="submit" className="btn-primary" disabled={busy || !can(me.permissions, "users.create")}>
              Provision account
            </button>
          </form>

          <div className="panel overflow-x-auto">
            <div className="flex flex-wrap items-end gap-3 border-b border-white/10 p-3">
              <div>
                <label className="label" htmlFor="filter-q">
                  Search
                </label>
                <input
                  id="filter-q"
                  className="field"
                  value={userFilter.q}
                  onChange={(event) => setUserFilter({ ...userFilter, q: event.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="filter-status">
                  Status
                </label>
                <select
                  id="filter-status"
                  className="field"
                  value={userFilter.status}
                  onChange={(event) => setUserFilter({ ...userFilter, status: event.target.value })}
                >
                  <option value="">any</option>
                  {["pending", "active", "suspended", "deactivated"].map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="filter-type">
                  Type
                </label>
                <select
                  id="filter-type"
                  className="field"
                  value={userFilter.userType}
                  onChange={(event) => setUserFilter({ ...userFilter, userType: event.target.value })}
                >
                  <option value="">any</option>
                  {["student", "teacher", "staff", "mentor", "counselor", "parent", "admin"].map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn-ghost" onClick={() => void run(refreshUsers)}>
                Apply filters
              </button>
            </div>

            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr>
                  {["Account", "Type", "Status", "Roles", "MFA", "Devices", "Last sign-in", "Actions"].map((header) => (
                    <th key={header} className="table-head px-3 py-2">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr key={user.id} className="hover:bg-white/[0.02]">
                    <td className="table-cell">
                      <span className="block font-medium text-slate-100">{user.name}</span>
                      <span className="block text-xs text-slate-500">{user.email}</span>
                    </td>
                    <td className="table-cell">{user.userType}</td>
                    <td className="table-cell">
                      <span
                        className={
                          user.status === "active"
                            ? "chip-ok"
                            : user.status === "pending"
                              ? "chip-warn"
                              : "chip-danger"
                        }
                      >
                        {user.status}
                      </span>
                    </td>
                    <td className="table-cell text-xs text-slate-400">{user.roleNames.join(", ") || "—"}</td>
                    <td className="table-cell text-xs">
                      {user.mfaEnabled ? "enabled" : user.mfaRequired ? "required" : "off"}
                    </td>
                    <td className="table-cell text-xs">{user.deviceCount}</td>
                    <td className="table-cell text-xs text-slate-500">
                      {user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : "never"}
                    </td>
                    <td className="table-cell">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => void run(async () => {
                            const detail = await apiFetch<{ members: unknown }>(
                              `/api/admin/users/${user.id}`,
                            );
                            void detail;
                            setExpandedUser(user);
                          })}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() =>
                            void run(async () => {
                              await apiFetch(`/api/admin/users/${user.id}/actions`, {
                                method: "POST",
                                body: { action: user.status === "active" ? "suspend" : "activate" },
                              });
                              setNotice(`${user.name} ${user.status === "active" ? "suspended" : "activated"}.`);
                              await refreshUsers();
                              await refreshAudit();
                            })
                          }
                        >
                          {user.status === "active" ? "Suspend" : "Activate"}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() =>
                            void run(async () => {
                              const result = await apiFetch<{ temporaryPassword?: string }>(
                                `/api/admin/users/${user.id}/actions`,
                                { method: "POST", body: { action: "reset_password" } },
                              );
                              setNotice(
                                result.temporaryPassword
                                  ? `Temporary password for ${user.email}: ${result.temporaryPassword}`
                                  : "Password reset.",
                              );
                              await refreshAudit();
                            })
                          }
                        >
                          Reset password
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() =>
                            void run(async () => {
                              await apiFetch(`/api/admin/users/${user.id}/actions`, {
                                method: "POST",
                                body: { action: "revoke_sessions" },
                              });
                              setNotice(`All sessions revoked for ${user.name}.`);
                            })
                          }
                        >
                          Force sign-out
                        </button>
                        <button
                          type="button"
                          className="btn-danger text-xs"
                          disabled={!can(me.permissions, "users.delete")}
                          onClick={() =>
                            void run(async () => {
                              await apiFetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
                              setNotice(`${user.name} soft-deleted; email obfuscated and sessions revoked.`);
                              await refreshUsers();
                              await refreshAudit();
                            })
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {expandedUser ? (
            <div className="panel space-y-3 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">
                  {expandedUser.name} · {expandedUser.email}
                </h2>
                <button type="button" className="btn-quiet text-xs" onClick={() => setExpandedUser(null)}>
                  Close
                </button>
              </div>
              <div className="grid gap-3 text-xs text-slate-400 sm:grid-cols-3">
                <p>Type: {expandedUser.userType}</p>
                <p>Department: {expandedUser.department ?? "—"}</p>
                <p>Grade / program: {expandedUser.gradeClass ?? expandedUser.program ?? "—"}</p>
                <p>Created: {new Date(expandedUser.createdAt).toLocaleString()}</p>
                <p>Locked: {expandedUser.lockedUntil ? new Date(expandedUser.lockedUntil).toLocaleString() : "no"}</p>
                <p>Devices: {expandedUser.deviceCount}</p>
              </div>

              <div className="flex flex-wrap gap-2">
                <select
                  className="field max-w-xs"
                  defaultValue=""
                  onChange={(event) =>
                    void run(async () => {
                      if (!event.target.value) return;
                      await apiFetch(`/api/admin/users/${expandedUser.id}/actions`, {
                        method: "POST",
                        body: { action: "assign_role", roleId: event.target.value },
                      });
                      setNotice("Role assigned.");
                      await refreshUsers();
                      await refreshAudit();
                    })
                  }
                >
                  <option value="">Assign role…</option>
                  {data.roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    void run(async () => {
                      await apiFetch(`/api/admin/users/${expandedUser.id}/actions`, {
                        method: "POST",
                        body: { action: expandedUser.mfaRequired ? "remove_mfa" : "require_mfa" },
                      });
                      setNotice(`MFA ${expandedUser.mfaRequired ? "requirement removed" : "required"}.`);
                      await refreshUsers();
                    })
                  }
                >
                  {expandedUser.mfaRequired ? "Remove MFA policy" : "Require MFA"}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    void run(async () => {
                      await apiFetch(`/api/admin/users/${expandedUser.id}/actions`, {
                        method: "POST",
                        body: { action: "unlock" },
                      });
                      setNotice("Lockout cleared.");
                      await refreshUsers();
                    })
                  }
                >
                  Clear lockout
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ───────────── groups ───────────── */}
      {tab === "groups" ? (
        <section className="space-y-4">
          <form
            className="panel grid gap-3 p-4 lg:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void run(async () => {
                await apiFetch("/api/admin/groups", {
                  method: "POST",
                  body: {
                    name: String(form.get("name") ?? ""),
                    description: String(form.get("description") ?? "") || undefined,
                    groupType: String(form.get("groupType") ?? "custom"),
                    status: String(form.get("status") ?? "draft"),
                    announcementOnly: form.get("announcementOnly") === "on",
                    retentionPolicyDays: Number(form.get("retentionPolicyDays") ?? 0) || undefined,
                  },
                });
                setNotice("Group created.");
                event.currentTarget.reset();
                await refreshGroups();
                await refreshAudit();
              });
            }}
          >
            <div>
              <label className="label" htmlFor="group-name">
                Group name
              </label>
              <input id="group-name" name="name" required className="field" />
            </div>
            <div>
              <label className="label" htmlFor="group-type">
                Type
              </label>
              <select id="group-type" name="groupType" className="field" defaultValue="advisory">
                {["class", "department", "program", "advisory", "custom"].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="group-status">
                Status
              </label>
              <select id="group-status" name="status" className="field" defaultValue="draft">
                <option value="draft">draft</option>
                <option value="active">active</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="group-retention">
                Retention (days)
              </label>
              <input id="group-retention" name="retentionPolicyDays" type="number" min={1} max={3650} className="field" />
            </div>
            <div className="lg:col-span-2">
              <label className="label" htmlFor="group-description">
                Description
              </label>
              <input id="group-description" name="description" className="field" />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" name="announcementOnly" className="h-4 w-4" /> Announcement-only
            </label>
            <button type="submit" className="btn-primary" disabled={busy || !can(me.permissions, "groups.create")}>
              Create group
            </button>
          </form>

          <div className="grid gap-3 lg:grid-cols-2">
            {data.groups.map((group) => (
              <article key={group.id} className="panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white">{group.name}</h3>
                    <p className="text-xs text-slate-500">
                      {group.groupType} · {group.memberCount} members · {group.conversationCount} channels
                    </p>
                  </div>
                  <span className={group.status === "active" ? "chip-ok" : group.status === "draft" ? "chip-warn" : "chip"}>
                    {group.status}
                  </span>
                </div>
                {group.description ? <p className="mt-2 text-xs text-slate-400">{group.description}</p> : null}
                <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-slate-500">
                  {group.announcementOnly ? <span className="chip-warn">announcement-only</span> : null}
                  {group.retentionPolicyDays ? <span className="chip">{group.retentionPolicyDays}d retention</span> : null}
                  {group.maxMembers ? <span className="chip">max {group.maxMembers}</span> : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() =>
                      void run(async () => {
                        const payload = await apiFetch<{ members: typeof groupMembers }>(
                          `/api/admin/groups/${group.id}/members`,
                        );
                        setGroupMembers(payload.members);
                        setGroupMemberView(group.id);
                      })
                    }
                  >
                    Roster
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() =>
                      void run(async () => {
                        await apiFetch(`/api/admin/groups/${group.id}`, {
                          method: "POST",
                          body: { action: group.status === "archived" ? "restore" : "archive" },
                        });
                        await refreshGroups();
                        await refreshAudit();
                      })
                    }
                  >
                    {group.status === "archived" ? "Restore" : "Archive"}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() =>
                      void run(async () => {
                        await apiFetch(`/api/admin/groups/${group.id}`, {
                          method: "PATCH",
                          body: { status: group.status === "active" ? "draft" : "active" },
                        });
                        await refreshGroups();
                      })
                    }
                  >
                    {group.status === "active" ? "Move to draft" : "Activate"}
                  </button>
                  <button
                    type="button"
                    className="btn-danger text-xs"
                    disabled={!can(me.permissions, "groups.delete")}
                    onClick={() =>
                      void run(async () => {
                        await apiFetch(`/api/admin/groups/${group.id}`, { method: "DELETE" });
                        setNotice(`${group.name} soft-deleted.`);
                        await refreshGroups();
                        await refreshAudit();
                      })
                    }
                  >
                    Delete
                  </button>
                </div>

                {groupMemberView === group.id ? (
                  <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        const ids = String(form.get("userIds") ?? "")
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean);
                        void run(async () => {
                          await apiFetch(`/api/admin/groups/${group.id}/members`, {
                            method: "POST",
                            body: { userIds: ids, memberRole: String(form.get("memberRole") ?? "member") },
                          });
                          const payload = await apiFetch<{ members: typeof groupMembers }>(
                            `/api/admin/groups/${group.id}/members`,
                          );
                          setGroupMembers(payload.members);
                          await refreshGroups();
                          await refreshAudit();
                        });
                      }}
                    >
                      <select name="memberRole" className="field max-w-[130px]">
                        <option value="member">member</option>
                        <option value="moderator">moderator</option>
                        <option value="admin">admin</option>
                      </select>
                      <input
                        name="userIds"
                        className="field"
                        placeholder="Account id(s), comma separated"
                        list={`user-ids-${group.id}`}
                      />
                      <datalist id={`user-ids-${group.id}`}>
                        {data.users.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                      </datalist>
                      <button type="submit" className="btn-primary text-xs" disabled={busy}>
                        Add
                      </button>
                    </form>
                    <ul className="mt-2 space-y-1 text-xs">
                      {groupMembers.map((member) => (
                        <li key={member.userId} className="flex items-center justify-between gap-2">
                          <span className="text-slate-300">
                            {member.name} <span className="text-slate-500">({member.memberRole})</span>
                          </span>
                          <button
                            type="button"
                            className="text-rose-200 hover:underline"
                            onClick={() =>
                              void run(async () => {
                                await apiFetch(
                                  `/api/admin/groups/${group.id}/members?userId=${encodeURIComponent(member.userId)}`,
                                  { method: "DELETE" },
                                );
                                const payload = await apiFetch<{ members: typeof groupMembers }>(
                                  `/api/admin/groups/${group.id}/members`,
                                );
                                setGroupMembers(payload.members);
                                await refreshGroups();
                              })
                            }
                          >
                            remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {/* ───────────── invitations ───────────── */}
      {tab === "invitations" ? (
        <section className="space-y-4">
          <form
            className="panel grid gap-3 p-4 lg:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void run(async () => {
                const payload = await apiFetch<{ onboardingUrl: string; email: string }>(
                  "/api/admin/invitations",
                  {
                    method: "POST",
                    body: {
                      email: String(form.get("email") ?? ""),
                      firstName: String(form.get("firstName") ?? ""),
                      lastName: String(form.get("lastName") ?? ""),
                      userType: String(form.get("userType") ?? "student"),
                      expiresInDays: Number(form.get("expiresInDays") ?? 7),
                    },
                  },
                );
                setIssuedInvite({ onboardingUrl: payload.onboardingUrl, email: payload.email });
                event.currentTarget.reset();
                const refreshed = await apiFetch<{ invitations: InvitationRow[] }>("/api/admin/invitations");
                setData((previous) => ({ ...previous, invitations: refreshed.invitations }));
                await refreshAudit();
              });
            }}
          >
            <div>
              <label className="label" htmlFor="invite-email">
                Email
              </label>
              <input id="invite-email" name="email" type="email" required className="field" />
            </div>
            <div>
              <label className="label" htmlFor="invite-first">
                First name
              </label>
              <input id="invite-first" name="firstName" required className="field" />
            </div>
            <div>
              <label className="label" htmlFor="invite-last">
                Last name
              </label>
              <input id="invite-last" name="lastName" required className="field" />
            </div>
            <div>
              <label className="label" htmlFor="invite-type">
                Type
              </label>
              <select id="invite-type" name="userType" className="field" defaultValue="student">
                {["student", "teacher", "staff", "mentor", "counselor", "parent"].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="invite-expiry">
                Expires in (days)
              </label>
              <input id="invite-expiry" name="expiresInDays" type="number" min={1} max={30} defaultValue={7} className="field" />
            </div>
            <button type="submit" className="btn-primary lg:col-span-2" disabled={busy}>
              Issue onboarding invitation
            </button>
          </form>

          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr>
                  {["Invitee", "Type", "Role", "Status", "Expires", "Actions"].map((header) => (
                    <th key={header} className="table-head px-3 py-2">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td className="table-cell">
                      <span className="block text-slate-100">
                        {invitation.firstName} {invitation.lastName}
                      </span>
                      <span className="block text-xs text-slate-500">{invitation.email}</span>
                    </td>
                    <td className="table-cell">{invitation.userType}</td>
                    <td className="table-cell text-xs">{invitation.roleName ?? "—"}</td>
                    <td className="table-cell">
                      <span
                        className={
                          invitation.status === "accepted"
                            ? "chip-ok"
                            : invitation.status === "revoked" || invitation.status === "expired"
                              ? "chip-danger"
                              : "chip-warn"
                        }
                      >
                        {invitation.status}
                      </span>
                    </td>
                    <td className="table-cell text-xs text-slate-500">
                      {new Date(invitation.expiresAt).toLocaleString()}
                    </td>
                    <td className="table-cell">
                      <button
                        type="button"
                        className="btn-danger text-xs"
                        disabled={invitation.status === "accepted"}
                        onClick={() =>
                          void run(async () => {
                            await apiFetch(`/api/admin/invitations?id=${encodeURIComponent(invitation.id)}`, {
                              method: "DELETE",
                            });
                            const refreshed = await apiFetch<{ invitations: InvitationRow[] }>("/api/admin/invitations");
                            setData((previous) => ({ ...previous, invitations: refreshed.invitations }));
                            await refreshAudit();
                          })
                        }
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ───────────── reports ───────────── */}
      {tab === "reports" ? (
        <section className="space-y-3">
          {data.reports.length === 0 ? (
            <p className="panel p-4 text-sm text-slate-400">No reports submitted.</p>
          ) : (
            data.reports.map((report) => (
              <article key={report.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white">{report.reason}</h3>
                    <p className="text-xs text-slate-500">
                      {report.reporterName ?? "unknown reporter"} · {report.targetType} {report.targetId} ·{" "}
                      {formatRelativeTime(report.createdAt)}
                    </p>
                  </div>
                  <span
                    className={
                      report.status === "resolved"
                        ? "chip-ok"
                        : report.status === "dismissed"
                          ? "chip"
                          : report.status === "under_review"
                            ? "chip-info"
                            : "chip-warn"
                    }
                  >
                    {report.status}
                  </span>
                </div>
                {report.description ? <p className="mt-2 text-sm text-slate-300">{report.description}</p> : null}
                {report.submittedContent ? (
                  <blockquote className="mt-2 rounded-lg border border-white/10 bg-black/30 p-3 text-xs italic text-slate-300">
                    “{report.submittedContent}”
                    <footer className="mt-1 not-italic text-slate-500">
                      Reporter-supplied excerpt — the platform cannot decrypt messages itself.
                    </footer>
                  </blockquote>
                ) : (
                  <p className="mt-2 text-xs text-slate-500">
                    No excerpt supplied. Reviewers cannot read the underlying ciphertext.
                  </p>
                )}
                <form
                  className="mt-3 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void run(async () => {
                      await apiFetch("/api/admin/reports", {
                        method: "PATCH",
                        body: {
                          id: report.id,
                          status: String(form.get("status") ?? "under_review"),
                          resolutionNotes: String(form.get("resolutionNotes") ?? "") || undefined,
                        },
                      });
                      const refreshed = await apiFetch<{ reports: ReportRow[] }>("/api/admin/reports?status=all");
                      setData((previous) => ({ ...previous, reports: refreshed.reports }));
                      await refreshAudit();
                    });
                  }}
                >
                  <select name="status" className="field max-w-[180px]" defaultValue={report.status}>
                    {["under_review", "resolved", "dismissed"].map((status) => (
                      <option key={status} value={status}>
                        {status.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                  <input
                    name="resolutionNotes"
                    className="field flex-1"
                    placeholder="Resolution notes (shared with the reporter)"
                    defaultValue={report.resolutionNotes ?? ""}
                    disabled={!can(me.permissions, "reports.resolve")}
                  />
                  <button type="submit" className="btn-primary" disabled={busy || !can(me.permissions, "reports.resolve")}>
                    Update
                  </button>
                </form>
              </article>
            ))
          )}
        </section>
      ) : null}

      {/* ───────────── audit ───────────── */}
      {tab === "audit" ? (
        <section className="panel overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr>
                {["Event", "Actor", "Target", "Result", "IP", "When"].map((header) => (
                  <th key={header} className="table-head px-3 py-2">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.audit.map((row) => (
                <tr key={row.id}>
                  <td className="table-cell">
                    <span className="block text-slate-100">{row.eventType}</span>
                    <span className="block text-xs text-slate-500">{row.action}</span>
                  </td>
                  <td className="table-cell text-xs">
                    {row.actorName ?? row.actorId}
                    <span className="block text-slate-500">{row.actorRole ?? "—"}</span>
                  </td>
                  <td className="table-cell text-xs">
                    {row.targetType ?? "—"}
                    <span className="block text-slate-500">{row.targetId ?? ""}</span>
                  </td>
                  <td className="table-cell">
                    <span className={row.result === "success" ? "chip-ok" : "chip-danger"}>{row.result}</span>
                  </td>
                  <td className="table-cell text-xs text-slate-500">{row.ipAddress ?? "—"}</td>
                  <td className="table-cell text-xs text-slate-500">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {/* ───────────── security ───────────── */}
      {tab === "security" ? (
        <section className="panel overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr>
                {["Event", "Severity", "User", "IP", "When"].map((header) => (
                  <th key={header} className="table-head px-3 py-2">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.security.map((row) => (
                <tr key={row.id}>
                  <td className="table-cell">{row.eventType}</td>
                  <td className="table-cell">
                    <span
                      className={
                        row.severity === "critical" ? "chip-danger" : row.severity === "warning" ? "chip-warn" : "chip"
                      }
                    >
                      {row.severity}
                    </span>
                  </td>
                  <td className="table-cell text-xs">{row.userName ?? "—"}</td>
                  <td className="table-cell text-xs text-slate-500">{row.ipAddress ?? "—"}</td>
                  <td className="table-cell text-xs text-slate-500">{new Date(row.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {/* ───────────── settings ───────────── */}
      {tab === "settings" ? (
        <section className="space-y-3">
          <p className="text-sm text-slate-400">
            Policy switches are stored centrally and referenced by the messaging APIs. The
            no-public-registration rule cannot be switched on from any surface.
          </p>
          <div className="panel divide-y divide-white/5">
            {initial.settings.map((setting) => {
              const value = policyDraft[setting.key];
              const locked =
                setting.key === "registration.public_signup_enabled" || setting.key === "bootstrap.version";
              return (
                <div key={setting.key} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-[240px] flex-1">
                    <p className="text-sm font-medium text-slate-100">{setting.key}</p>
                    <p className="text-xs text-slate-500">{setting.description}</p>
                  </div>
                  {typeof value === "boolean" ? (
                    <label className="flex items-center gap-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={value}
                        disabled={locked || !can(me.permissions, "settings.manage")}
                        onChange={(event) =>
                          setPolicyDraft((previous) => ({ ...previous, [setting.key]: event.target.checked }))
                        }
                      />
                      {value ? "enabled" : "disabled"}
                    </label>
                  ) : (
                    <input
                      className="field max-w-[200px]"
                      value={String(value ?? "")}
                      disabled={locked || !can(me.permissions, "settings.manage")}
                      onChange={(event) =>
                        setPolicyDraft((previous) => ({
                          ...previous,
                          [setting.key]: Number.isNaN(Number(event.target.value))
                            ? event.target.value
                            : Number(event.target.value),
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !can(me.permissions, "settings.manage")}
            onClick={() =>
              void run(async () => {
                const payload = await apiFetch<{ settings: SettingRow[] }>("/api/admin/settings", {
                  method: "PUT",
                  body: { settings: policyDraft },
                });
                setData((previous) => ({ ...previous, settings: payload.settings }));
                setNotice("Policies saved.");
                await refreshAudit();
              })
            }
          >
            Save policies
          </button>
          {!can(me.permissions, "settings.manage") ? (
            <p className="text-xs text-slate-500">
              Only a super admin can change platform policy — you have read-only access.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
