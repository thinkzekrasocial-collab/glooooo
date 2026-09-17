"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type User = { email: string; firstName?: string; preferredName?: string; userType?: string; status?: string };

export default function SettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [message, setMessage] = useState("Loading account from Cloudflare…");
  useEffect(() => {
    apiFetch<User>("/api/users/me").then(value => { setUser(value); setMessage("Account is connected to Cloudflare D1."); }).catch(error => setMessage(error instanceof Error ? error.message : "Account could not be loaded."));
  }, []);
  return <main className="mx-auto w-full max-w-3xl space-y-6 p-6 lg:p-10">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Cloudflare account</p><h1 className="mt-2 text-3xl font-semibold text-white">Settings</h1><p className="mt-2 text-sm text-slate-400">Your account session and messenger data are connected to the Worker API.</p></div>
    <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">{message}</p>
    <section className="panel p-6"><h2 className="text-lg font-semibold text-white">Profile</h2><dl className="mt-5 grid gap-4 sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-slate-500">Email</dt><dd className="mt-1 text-slate-200">{user?.email ?? "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Name</dt><dd className="mt-1 text-slate-200">{user?.preferredName || user?.firstName || "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Account type</dt><dd className="mt-1 text-slate-200">{user?.userType ?? "—"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-slate-500">Status</dt><dd className="mt-1 text-emerald-300">{user?.status ?? "—"}</dd></div></dl></section>
    <section className="panel p-6"><h2 className="text-lg font-semibold text-white">Security</h2><p className="mt-2 text-sm text-slate-400">Your session uses a bearer token and browser-held encryption keys. Message plaintext is not sent to Cloudflare.</p><p className="mt-4 text-xs text-slate-500">Use Sign out in the left navigation to revoke this session.</p></section>
  </main>;
}
