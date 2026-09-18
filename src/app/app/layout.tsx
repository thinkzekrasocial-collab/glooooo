"use client";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { ApiClientError, apiFetch } from "@/lib/api-client";

type RemoteMe = { id: string; name?: string; email?: string; firstName?: string; preferredName?: string | null; userType?: string; roles?: string[]; permissions?: string[]; canAdmin?: boolean; mfaEnabled?: boolean; mfaRequired?: boolean; user?: { id: string; name: string; email: string; firstName: string; preferredName?: string | null; userType: string; mfaEnabled: boolean; mfaRequired: boolean }; };

export default function AppLayout({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<RemoteMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const router = useRouter();

  const loadSession = useCallback(async () => {
    setLoading(true);
    setSessionError(null);
    try {
      setMe(await apiFetch<RemoteMe>("/api/users/me"));
    } catch (error) {
      if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
        router.replace("/login");
        return;
      }
      setSessionError(error instanceof Error ? error.message : "The secure session could not be checked.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (loading || !me) {
    return (
      <main className="mx-auto max-w-xl p-8 text-slate-300">
        {sessionError ? (
          <section className="panel space-y-3 p-5" role="alert">
            <h1 className="text-base font-semibold text-rose-200">Session check failed</h1>
            <p className="text-sm text-slate-400">{sessionError}</p>
            <button type="button" className="btn-primary" onClick={() => void loadSession()}>
              Retry
            </button>
          </section>
        ) : (
          "Loading secure session…"
        )}
      </main>
    );
  }
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
