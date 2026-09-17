"use client";

import { useEffect, useState } from "react";
import { Messenger } from "@/components/messenger/Messenger";
import { apiFetch } from "@/lib/api-client";
import type { ConversationSummary, DirectoryEntry } from "@/lib/data";

type RemoteUser = { id: string; email: string; firstName?: string; preferredName?: string; permissions?: string[] };

export default function MessengerPage() {
  const [user, setUser] = useState<RemoteUser | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);

  useEffect(() => {
    Promise.all([
      apiFetch<RemoteUser>("/api/users/me"),
      apiFetch<{ conversations: ConversationSummary[] }>("/api/conversations"),
      apiFetch<{ users?: DirectoryEntry[] }>("/api/directory").catch(() => ({ users: [] })),
    ]).then(([remoteUser, channels, people]) => {
      setUser(remoteUser);
      setConversations(channels.conversations);
      setDirectory(people.users ?? []);
    }).catch(() => setUser(null));
  }, []);

  if (!user) return <main className="p-8 text-slate-300">Connecting to Cloudflare…</main>;
  return <Messenger me={{ id: user.id, name: user.preferredName || user.firstName || user.email, permissions: user.permissions ?? [] }} initialConversations={conversations} initialDirectory={directory} initialConversationId={conversations[0]?.id ?? null} />;
}
