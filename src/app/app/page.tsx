import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import MessengerPageClient from "./MessengerPageClient";
import type { ConversationSummary, DirectoryEntry } from "@/lib/data";

export const dynamic = "force-dynamic";

type RemoteUser = { id: string; email: string; firstName?: string; preferredName?: string; permissions?: string[]; groups?: Array<{ id: string; name: string; memberRole?: string }> };

async function workerGet<T>(path: string): Promise<T | null> {
  const token = (await cookies()).get("gb_session_token")?.value;
  if (!token) return null;
  try {
    const response = await fetch(`https://demoo.shihab309kye.workers.dev${path}`, { headers: { Authorization: `Bearer ${decodeURIComponent(token)}` }, cache: "no-store" });
    return response.ok ? await response.json() as T : null;
  } catch { return null; }
}

export default async function MessengerPage() {
  const [user, channels, directoryResponse] = await Promise.all([
    workerGet<RemoteUser>("/api/users/me"),
    workerGet<{ conversations: ConversationSummary[] }>("/api/conversations"),
    workerGet<{ users?: Array<{ id: string; email: string; name: string; userType: string }> }>("/api/directory"),
  ]);
  if (!user || !channels) redirect("/login");
  const directory: DirectoryEntry[] = (directoryResponse?.users ?? []).map((entry) => ({
    ...entry,
    status: "active",
    department: null,
    gradeClass: null,
    program: null,
    roleNames: [],
    sharedGroups: [],
  }));
  return <MessengerPageClient user={user} conversations={channels.conversations ?? []} directory={directory} />;
}
