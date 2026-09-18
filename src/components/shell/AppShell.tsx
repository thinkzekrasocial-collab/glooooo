"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ApiClientError, apiFetch, formatRelativeTime, setLegacyBearerToken } from "@/lib/api-client";
import { E2eeUnavailableError, ensureDeviceIdentity } from "@/lib/e2ee";

type Me = {
  id: string;
  name: string;
  email: string;
  userType: string;
  roles: string[];
  permissions: string[];
  canAdmin: boolean;
  mfaEnabled: boolean;
  mfaRequired: boolean;
};

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
};

export function AppShell({
  me,
  unreadNotifications,
  children,
}: {
  me: Me;
  unreadNotifications: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(unreadNotifications);
  const [secureState, setSecureState] = useState<
    { status: "loading" | "ready" | "unavailable"; deviceId?: string; message?: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    ensureDeviceIdentity()
      .then((identity) => {
        if (cancelled) return;
        setSecureState({ status: "ready", deviceId: identity.deviceId });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSecureState({
          status: "unavailable",
          message:
            error instanceof E2eeUnavailableError
              ? error.message
              : "Encrypted messaging is unavailable in this browser profile.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshUnread = () => {
      void apiFetch<{ unreadCount: number }>("/api/notifications")
        .then((payload) => { if (!cancelled) setUnread(payload.unreadCount); })
        .catch(() => undefined);
    };
    refreshUnread();
    const timer = window.setInterval(refreshUnread, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!notificationsOpen) return;
    let cancelled = false;
    void apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>("/api/notifications")
      .then((payload) => {
        if (cancelled) return;
        setNotifications(payload.notifications);
        setUnread(payload.unreadCount);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [notificationsOpen]);

  useEffect(() => {
    setDrawerOpen(false);
    setNotificationsOpen(false);
  }, [pathname]);

  async function markAllRead() {
    try {
      const payload = await apiFetch<{ unreadCount: number }>("/api/notifications", {
        method: "POST",
        body: { action: "read_all" },
      });
      setUnread(payload.unreadCount);
      setNotifications((items) => items.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    } catch (caught) {
      if (caught instanceof ApiClientError) return;
    }
  }

  async function signOut() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: {} });
    } finally {
      setLegacyBearerToken(null);
      router.replace("/login");
    }
  }

  const nav = [
    { href: "/app", label: "Messenger", icon: "💬", visible: true },
    { href: "/app/admin", label: "Admin console", icon: "🛡️", visible: me.canAdmin },
    { href: "/app/settings", label: "Settings", icon: "⚙️", visible: true },
  ].filter((item) => item.visible);

  return (
    <div className="flex min-h-screen">
      <aside
        className={`app-sidebar fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-white/10 px-4 py-5 transition-transform lg:static lg:translate-x-0 ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-10 w-10 rounded-xl" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">GlobeBridge Pathways</p>
            <p className="text-xs text-slate-500">Private encrypted messenger</p>
          </div>
        </div>

        <nav aria-label="Primary" className="mt-6 space-y-1">
          {nav.map((item) => {
            const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  active ? "bg-white/[0.08] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
                }`}
              >
                <span aria-hidden>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-6 panel-soft p-3 text-xs">
          <p className="font-semibold uppercase tracking-wide text-slate-400">Encryption status</p>
          {secureState.status === "ready" ? (
            <p className="mt-1 text-emerald-300">
              Device keys active
              <span className="mt-0.5 block truncate text-slate-500">{secureState.deviceId}</span>
            </p>
          ) : secureState.status === "loading" ? (
            <p className="mt-1 text-slate-400">Provisioning device keys…</p>
          ) : (
            <p className="mt-1 text-amber-300">{secureState.message}</p>
          )}
        </div>

        <div className="mt-auto pt-6">
          <div className="panel-soft p-3">
            <p className="truncate text-sm font-medium text-slate-100">{me.name}</p>
            <p className="truncate text-xs text-slate-500">{me.email}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {me.roles.map((role) => (
                <span key={role} className="chip-info">
                  {role.replace("_", " ")}
                </span>
              ))}
              {me.mfaEnabled ? <span className="chip-ok">MFA</span> : null}
              {me.mfaRequired && !me.mfaEnabled ? <span className="chip-warn">MFA required</span> : null}
            </div>
            <button type="button" className="btn-ghost mt-3 w-full" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-header sticky top-0 z-20 flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <button
            type="button"
            className="btn-quiet lg:hidden"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
          >
            ☰
          </button>
            <p className="text-sm font-semibold tracking-tight text-slate-200">
            {nav.find((item) =>
              item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href),
            )?.label ?? "Messenger"}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost relative"
              aria-expanded={notificationsOpen}
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <span aria-hidden className="text-base">◌</span> Notifications
              {unread > 0 ? (
                <span className="absolute -right-1 -top-1 rounded-full bg-[color:var(--color-rose-400)] px-1.5 text-[10px] font-bold text-[color:var(--color-ink-950)]">
                  {unread}
                </span>
              ) : null}
            </button>
          </div>
        </header>

        {notificationsOpen ? (
          <div className="border-b border-white/10 bg-[color:var(--color-ink-900)]/95 px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Notifications</h2>
              <div className="flex gap-2">
                <button type="button" className="btn-quiet text-xs" onClick={markAllRead}>
                  Mark all read
                </button>
                <button type="button" className="btn-quiet text-xs" onClick={() => setNotificationsOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {notifications.length === 0 ? (
                <li className="text-xs text-slate-500">Nothing yet. Security and channel events appear here.</li>
              ) : (
                notifications.map((item) => (
                  <li
                    key={item.id}
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      item.readAt ? "border-white/8 bg-white/[0.02] text-slate-400" : "border-white/12 bg-white/[0.05] text-slate-100"
                    }`}
                  >
                    <p className="font-medium">{item.title}</p>
                    {item.body ? <p className="text-xs text-slate-400">{item.body}</p> : null}
                    <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-500">
                      {item.type} · {formatRelativeTime(item.createdAt)}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}

        <main id="main" className="min-h-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
