"use client";

import { useEffect, useState } from "react";
import { Messenger } from "@/components/messenger/Messenger";
import { apiFetch } from "@/lib/api-client";
import type { ConversationSummary, DirectoryEntry } from "@/lib/data";

export const dynamic = "force-dynamic";

type RemoteUser = { id: string; email: string; firstName?: string; preferredName?: string; permissions?: string[]; groups?: Array<{ id: string; name: string; memberRole?: string }> };

export default function MessengerPage() {
  const [user, setUser] = useState<RemoteUser | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);

  useEffect(() => {
    Promise.all([
      apiFetch<RemoteUser>("/api/users/me"),
      apiFetch<{ conversations: ConversationSummary[] }>("/api/conversations"),
      apiFetch<{ people?: DirectoryEntry[] }>("/api/directory").catch(() => ({ people: [] })),
    ]).then(([remotePayload, channels, people]) => {
      const remoteUser = (remotePayload as RemoteUser & { user?: RemoteUser; roles?: string[] }).user
        ? { ...(remotePayload as RemoteUser & { user: RemoteUser }).user, permissions: (remotePayload as { permissions?: string[] }).permissions, groups: (remotePayload as { groups?: RemoteUser["groups"] }).groups }
        : remotePayload;
      setUser(remoteUser);
      setConversations(channels.conversations);
      setDirectory(people.people ?? []);
    }).catch(() => setUser(null));
  }, []);

  if (!user) return <main className="p-8 text-slate-300">Connecting to the secure messenger…</main>;
  return <Messenger me={{ id: user.id, name: user.preferredName || user.firstName || user.email, permissions: user.permissions ?? [] }} myGroups={user.groups ?? []} initialConversations={conversations} initialDirectory={directory} initialConversationId={conversations[0]?.id ?? null} />;
}
