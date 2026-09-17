"use client";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { apiFetch } from "@/lib/api-client";

type RemoteMe = { id: string; name?: string; email?: string; firstName?: string; preferredName?: string | null; userType?: string; roles?: string[]; permissions?: string[]; canAdmin?: boolean; mfaEnabled?: boolean; mfaRequired?: boolean; user?: { id: string; name: string; email: string; firstName: string; preferredName?: string | null; userType: string; mfaEnabled: boolean; mfaRequired: boolean }; };

export default function AppLayout({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<RemoteMe | null>(null);
  useEffect(() => { void apiFetch<RemoteMe>("/api/users/me").then(setMe).catch(() => setMe(null)); }, []);
  const current = me?.user ?? me;
  const permissions = me?.permissions ?? [];
  const canAdmin = Boolean(me?.canAdmin || permissions.includes("*") || permissions.includes("users.view") || permissions.includes("groups.view"));
  return (
    <AppShell
      me={{
        id: current?.id ?? "current-user",
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
