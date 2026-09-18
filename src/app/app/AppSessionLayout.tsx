import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";

type RemoteMe = { id: string; name?: string; email?: string; firstName?: string; preferredName?: string | null; userType?: string; roles?: string[]; permissions?: string[]; canAdmin?: boolean; mfaEnabled?: boolean; mfaRequired?: boolean; user?: { id: string; name: string; email: string; firstName: string; preferredName?: string | null; userType: string; mfaEnabled: boolean; mfaRequired: boolean } };

export function AppSessionLayout({ children, initialMe }: { children: ReactNode; initialMe: RemoteMe | null }) {
  if (!initialMe) redirect("/login");
  const current = initialMe.user ?? initialMe, permissions = initialMe.permissions ?? [];
  const canAdmin = Boolean(initialMe.canAdmin || permissions.includes("*") || permissions.includes("users.view") || permissions.includes("groups.view"));
  return <AppShell me={{ id: current.id, name: current.preferredName || current.name || current.firstName || current.email || "Messenger", email: current.email ?? "", userType: current.userType ?? "member", roles: initialMe.roles ?? [], permissions, canAdmin, mfaEnabled: current.mfaEnabled ?? false, mfaRequired: current.mfaRequired ?? false }} unreadNotifications={0}>{children}</AppShell>;
}
