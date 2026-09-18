import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { AppSessionLayout } from "./AppSessionLayout";

export const dynamic = "force-dynamic";

async function initialSession() {
  const token = (await cookies()).get("gb_session_token")?.value;
  if (!token) return null;
  try {
    const response = await fetch("https://demoo.shihab309kye.workers.dev/api/users/me", {
      headers: { Authorization: `Bearer ${decodeURIComponent(token)}` },
      cache: "no-store",
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppSessionLayout initialMe={initialSession()}>{children}</AppSessionLayout>;
}
