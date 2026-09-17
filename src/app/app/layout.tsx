"use client";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell
      me={{
        id: "cloudflare-user",
        name: "Messenger",
        email: "",
        userType: "member",
        roles: [],
        permissions: [],
        canAdmin: true,
        mfaEnabled: false,
        mfaRequired: false,
      }}
      unreadNotifications={0}
    >
      {children}
    </AppShell>
  );
}
