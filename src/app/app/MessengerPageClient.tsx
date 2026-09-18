"use client";

import { Messenger } from "@/components/messenger/Messenger";
import type { ConversationSummary, DirectoryEntry } from "@/lib/data";

type RemoteUser = { id: string; email: string; firstName?: string; preferredName?: string; permissions?: string[]; groups?: Array<{ id: string; name: string; memberRole?: string }> };

export default function MessengerPageClient({ user, conversations, directory }: { user: RemoteUser; conversations: ConversationSummary[]; directory: DirectoryEntry[] }) {
  return <Messenger me={{ id: user.id, name: user.preferredName || user.firstName || user.email, permissions: user.permissions ?? [] }} myGroups={user.groups ?? []} initialConversations={conversations} initialDirectory={directory} initialConversationId={conversations[0]?.id ?? null} />;
}
