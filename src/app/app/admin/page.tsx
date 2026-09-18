"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Overview = { users: Record<string, number>; messages: number; conversations: number };
type Account = { id: string; email: string; userType: string; roles: string[]; createdAt: string };

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("User#2026!Secure");
  const [status, setStatus] = useState("Loading administration data…");
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const totalUsers = overview ? Object.values(overview.users).reduce((sum, count) => sum + count, 0) : undefined;
  const activeUsers = overview?.users.active;

  async function load() {
    try {
      const me = await apiFetch<{ permissions?: string[]; canAdmin?: boolean; user?: { id: string } } & { id?: string }>("/api/users/me");
      const permissions = me.permissions ?? [];
      const allowed = Boolean(me.canAdmin || permissions.includes("*") || permissions.includes("users.view") || permissions.includes("groups.view"));
      setAuthorized(allowed);
      if (!allowed) { setStatus("Administrator access required."); return; }
      const [summary, users] = await Promise.all([
        apiFetch<Overview>("/api/admin/overview"),
        apiFetch<{ users: Account[] }>("/api/admin/users"),
      ]);
      setOverview(summary);
      setAccounts(users.users);
      setStatus("Connected to the secure administration API");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Administrator access required.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    try {
      await apiFetch("/api/admin/users", { method: "POST", body: { email, firstName, lastName, userType: "student", password } });
      setEmail("");
      setFirstName("");
      setLastName("");
      setStatus("Account created successfully");
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not create account"); }
  }

  if (authorized === false) return <main className="mx-auto max-w-2xl p-8"><section className="panel p-6"><h1 className="text-xl font-semibold text-white">Administrator access required</h1><p className="mt-2 text-sm text-slate-400">Your account is not authorized to view the administration console.</p></section></main>;
  return <main className="mx-auto w-full max-w-6xl space-y-6 p-6 lg:p-10">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Administration</p><h1 className="mt-2 text-3xl font-semibold text-white">Admin panel</h1><p className="mt-2 text-sm text-slate-400">Manage provisioned accounts and messenger data.</p></div>
    <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">{status}</p>
    <div className="grid gap-4 sm:grid-cols-4">{[["Users", totalUsers], ["Active users", activeUsers], ["Conversations", overview?.conversations], ["Messages", overview?.messages]].map(([label, value]) => <div className="panel p-5" key={String(label)}><p className="text-sm text-slate-400">{label}</p><p className="mt-2 text-3xl font-semibold text-white">{value ?? "—"}</p></div>)}</div>
    <section className="panel p-5"><h2 className="text-lg font-semibold text-white">Provision user account</h2><form className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-5" onSubmit={createAccount}><input className="field" required placeholder="First name" value={firstName} onChange={e => setFirstName(e.target.value)} /><input className="field" required placeholder="Last name" value={lastName} onChange={e => setLastName(e.target.value)} /><input className="field" type="email" required placeholder="user@example.com" value={email} onChange={e => setEmail(e.target.value)} /><input className="field" required minLength={12} placeholder="Temporary password" value={password} onChange={e => setPassword(e.target.value)} /><button className="btn-primary" type="submit">Create account</button></form></section>
    <section className="panel overflow-hidden p-5"><h2 className="text-lg font-semibold text-white">Accounts</h2><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr><th className="pb-3">Email</th><th className="pb-3">Role</th><th className="pb-3">Created</th></tr></thead><tbody>{accounts.map(account => <tr className="border-t border-white/10" key={account.id}><td className="py-3 text-slate-200">{account.email}</td><td className="py-3 text-slate-400">{account.roles?.join(", ") || account.userType}</td><td className="py-3 text-slate-500">{account.createdAt ? new Date(account.createdAt).toLocaleString() : "—"}</td></tr>)}</tbody></table></div></section>
  </main>;
}
