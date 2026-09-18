"use client";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { apiFetch } from "@/lib/api-client";

type RemoteMe = { id: string; name?: string; email?: string; firstName?: string; preferredName?: string | null; userType?: string; roles?: string[]; permissions?: string[]; canAdmin?: boolean; mfaEnabled?: boolean; mfaRequired?: boolean; user?: { id: string; name: string; email: string; firstName: string; preferredName?: string | null; userType: string; mfaEnabled: boolean; mfaRequired: boolean }; };

export default function AppLayout({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<RemoteMe | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  useEffect(() => {
    void apiFetch<RemoteMe>("/api/users/me")
      .then((value) => setMe(value))
      .catch(() => router.replace("/login"))
      .finally(() => setLoading(false));
  }, [router]);
  if (loading || !me) return <main className="p-8 text-slate-300">Loading secure session…</main>;
  const current = me?.user ?? me;
  const permissions = me?.permissions ?? [];
  const canAdmin = Boolean(me?.canAdmin || permissions.includes("*") || permissions.includes("users.view") || permissions.includes("groups.view"));
  return (
    <AppShell
      me={{
        id: current.id,
        name: current?.preferredName || current?.name || current?.firstName || current?.email || "Messenger",
        email: current?.email ?? "",
        userType: current?.userType ?? "member",
        roles: me?.roles ?? [],
        permissions,
        canAdmin,
        mfaEnabled: current?.mfaEnabled ?? false,
        mfaRequired: current?.mfaRequired ?? false,
      }}
      unreadNotifications={0}
    >
      {children}
    </AppShell>
  );
}
