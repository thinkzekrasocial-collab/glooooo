"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Overview = { users: number; messages: number; conversations: number; activeUsers: number };
type Account = { id: string; email: string; userType: string; roles: string[]; createdAt: string };

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("User#2026!");
  const [status, setStatus] = useState("Loading Cloudflare admin data…");

  async function load() {
    try {
      const [summary, users] = await Promise.all([
        apiFetch<{ overview: Overview }>("/api/admin/overview"),
        apiFetch<{ users: Account[] }>("/api/admin/users"),
      ]);
      setOverview(summary.overview);
      setAccounts(users.users);
      setStatus("Connected to Cloudflare D1");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Administrator access required.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    try {
      await apiFetch("/api/admin/users", { method: "POST", body: { email, password } });
      setEmail("");
      setStatus("Account created in Cloudflare D1");
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not create account"); }
  }

  return <main className="mx-auto w-full max-w-6xl space-y-6 p-6 lg:p-10">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Cloudflare control plane</p><h1 className="mt-2 text-3xl font-semibold text-white">Admin panel</h1><p className="mt-2 text-sm text-slate-400">Accounts and messenger data are stored in the connected D1 database.</p></div>
    <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">{status}</p>
    <div className="grid gap-4 sm:grid-cols-4">{[["Users", overview?.users], ["Active users", overview?.activeUsers], ["Conversations", overview?.conversations], ["Messages", overview?.messages]].map(([label, value]) => <div className="panel p-5" key={String(label)}><p className="text-sm text-slate-400">{label}</p><p className="mt-2 text-3xl font-semibold text-white">{value ?? "—"}</p></div>)}</div>
    <section className="panel p-5"><h2 className="text-lg font-semibold text-white">Provision user account</h2><form className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={createAccount}><input className="field" type="email" required placeholder="user@example.com" value={email} onChange={e => setEmail(e.target.value)} /><input className="field" required minLength={8} placeholder="Temporary password" value={password} onChange={e => setPassword(e.target.value)} /><button className="btn-primary" type="submit">Create account</button></form></section>
    <section className="panel overflow-hidden p-5"><h2 className="text-lg font-semibold text-white">Accounts</h2><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr><th className="pb-3">Email</th><th className="pb-3">Role</th><th className="pb-3">Created</th></tr></thead><tbody>{accounts.map(account => <tr className="border-t border-white/10" key={account.id}><td className="py-3 text-slate-200">{account.email}</td><td className="py-3 text-slate-400">{account.roles?.join(", ") || account.userType}</td><td className="py-3 text-slate-500">{account.createdAt ? new Date(account.createdAt).toLocaleString() : "—"}</td></tr>)}</tbody></table></div></section>
  </main>;
}
