"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationSummary, DirectoryEntry, MessageDto } from "@/lib/data";
import { ApiClientError, apiFetch, formatClock, formatRelativeTime } from "@/lib/api-client";
import {
  cacheConversationKey,
  decryptFile,
  decryptText,
  encryptFile,
  encryptText,
  getCachedConversationKey,
  newConversationKeyMaterial,
  unwrapConversationKey,
  wrapConversationKey,
} from "@/lib/e2ee";

type ChatMessage = MessageDto & { plaintext?: string; localPending?: boolean; localFailed?: boolean };

type MemberDevice = {
  deviceId: string;
  userId: string;
  deviceName: string;
  publicKey: string;
  hasKey: boolean;
};

type KeyInfo = {
  myDeviceId: string | null;
  myDeviceRegistered: boolean;
  haveKey: boolean;
  myWrap: { wrappedKey: string; wrappedKeyIv: string; senderDeviceId: string; wrapVersion: number } | null;
  memberDevices: MemberDevice[];
  pendingDevices: Array<{ deviceId: string; userId: string; publicKey: string }>;
};

type ConversationDetail = {
  conversation: {
    id: string;
    type: string;
    title: string;
    groupId: string | null;
    status: string;
    policy: {
      announcementOnly: boolean;
      fileSharingEnabled: boolean;
      retentionPolicyDays: number | null;
      visibility: string;
    };
  };
  membership: { role: string; lastReadAt: string | null; mutedUntil: string | null; archived: boolean };
  members: Array<{
    userId: string;
    name: string;
    userType: string;
    status: string;
    role: string;
    online: boolean;
    deviceCount: number;
  }>;
  typing: Array<{ userId: string; name: string }>;
  encryption: { hasKeyForMyDevice: boolean; myDeviceId: string | null; pendingKeyDevices: Array<{ deviceId: string; userId: string }> };
};

type MessagesResponse = {
  messages: MessageDto[];
  typing: Array<{ userId: string; name: string }>;
  readCursors: Array<{ userId: string; lastReadAt: string | null }>;
  serverTime: string;
};

const REPORT_REASONS = [
  "Harassment or bullying",
  "Hate speech",
  "Sexual content",
  "Threats or violence",
  "Spam or scam",
  "Sharing private information",
  "Other safety concern",
];

function localId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function statusGlyph(message: ChatMessage): string {
  if (message.localFailed) return "⚠ failed";
  if (message.localPending || message.status === "sending") return "◌ sending";
  if (message.status === "read") return "✓✓ read";
  if (message.status === "delivered") return "✓✓ delivered";
  if (message.status === "deleted") return "deleted";
  return "✓ sent";
}

export function Messenger({
  me,
  initialConversations,
  initialDirectory,
  initialConversationId,
}: {
  me: { id: string; name: string; permissions: string[] };
  initialConversations: ConversationSummary[];
  initialDirectory: DirectoryEntry[];
  initialConversationId: string | null;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [directory] = useState(initialDirectory);
  const [activeId, setActiveId] = useState<string | null>(
    initialConversationId ?? initialConversations[0]?.id ?? null,
  );
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState<Array<{ userId: string; name: string }>>([]);
  const [draft, setDraft] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [peopleQuery, setPeopleQuery] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState<ChatMessage | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyState, setKeyState] = useState<{
    status: "idle" | "loading" | "ready" | "waiting" | "error";
    pending: number;
    message?: string;
  }>({ status: "idle", pending: 0 });
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const [mobilePane, setMobilePane] = useState<"list" | "thread">(initialConversationId ? "thread" : "list");
  const [activeMeeting, setActiveMeeting] = useState<{ id: string; status: string; type: string } | null>(null);

  const plaintextRef = useRef<Map<string, string>>(new Map());
  const keyMaterialRef = useRef<Map<string, string>>(new Map());
  const typingSentRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [conversations, activeId],
  );

  useEffect(() => {
    if (!activeConversation?.groupId) { setActiveMeeting(null); return; }
    let cancelled = false;
    const refresh = () => void apiFetch<{ meeting: { id: string; status: string; type: string } | null }>(`/api/video-meetings?groupId=${encodeURIComponent(activeConversation.groupId!)}`)
      .then((payload) => { if (!cancelled) setActiveMeeting(payload.meeting); })
      .catch(() => { if (!cancelled) setActiveMeeting(null); });
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeConversation?.groupId]);

  async function startMeeting(type: "video" | "voice") {
    if (!activeConversation?.groupId) return;
    try {
      const payload = await apiFetch<{ meeting: { id: string } }>("/api/video-meetings", { method: "POST", body: { groupId: activeConversation.groupId, type, title: `${activeConversation.title} ${type} call` } });
      window.location.assign(`/app/groups/${activeConversation.groupId}/video-call/${payload.meeting.id}`);
    } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : "Unable to start the conference."); }
  }

  async function restartMeeting() {
    if (!activeConversation?.groupId || !activeMeeting) return;
    try {
      await apiFetch(`/api/video-meetings/${activeMeeting.id}?action=end`, { method: "POST" });
      await startMeeting(activeMeeting.type === "voice" ? "voice" : "video");
    } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : "Unable to restart the conference."); }
  }

  const filteredConversations = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter(
      (conversation) =>
        (conversation.title ?? "").toLowerCase().includes(needle) ||
        conversation.members.some((member) => member.name.toLowerCase().includes(needle)),
    );
  }, [conversations, searchTerm]);

  const filteredPeople = useMemo(() => {
    const needle = peopleQuery.trim().toLowerCase();
    if (!needle) return directory;
    return directory.filter(
      (person) =>
        person.name.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle),
    );
  }, [directory, peopleQuery]);

  const resolveKeys = useCallback(async (conversationId: string) => {
    const keys = await apiFetch<KeyInfo>(`/api/conversations/${conversationId}/keys`);
    let material: string | null = null;

    if (keys.myWrap) {
      const sender = keys.memberDevices.find((device) => device.deviceId === keys.myWrap?.senderDeviceId);
      if (sender) {
        try {
          material = await unwrapConversationKey({
            conversationId,
            wrappedKey: keys.myWrap.wrappedKey,
            wrappedKeyIv: keys.myWrap.wrappedKeyIv,
            senderPublicJwk: JSON.parse(sender.publicKey) as JsonWebKey,
          });
          keyMaterialRef.current.set(conversationId, material);
        } catch {
          material = null;
        }
      }
    }

    if (!material) {
      material = (await getCachedConversationKey(conversationId)) ?? keyMaterialRef.current.get(conversationId) ?? null;
      if (material) keyMaterialRef.current.set(conversationId, material);
    }

    // Brand-new channel: the first member to open it mints the key and wraps it
    // for every registered device (including its own).
    if (!material && keys.memberDevices.length > 0 && keys.memberDevices.every((d) => !d.hasKey)) {
      const fresh = newConversationKeyMaterial();
      // Unlock this browser immediately; distribution to other devices is best-effort.
      await cacheConversationKey(conversationId, fresh);
      keyMaterialRef.current.set(conversationId, fresh);
      material = fresh;
      const grants: Array<{ deviceId: string; wrappedKey: string; wrappedKeyIv: string }> = [];
      for (const device of keys.memberDevices) {
        try {
          const wrapped = await wrapConversationKey({
            conversationId,
            materialB64: fresh,
            recipientPublicJwk: JSON.parse(device.publicKey) as JsonWebKey,
          });
          grants.push({ deviceId: device.deviceId, ...wrapped });
        } catch {
          // A stale device must not prevent the current browser from opening the channel.
        }
      }
      if (grants.length > 0) await apiFetch(`/api/conversations/${conversationId}/keys`, { method: "POST", body: { grants } }).catch(() => undefined);
    }

    if (material && keys.pendingDevices.length > 0) {
      const grants: Array<{ deviceId: string; wrappedKey: string; wrappedKeyIv: string }> = [];
      for (const device of keys.pendingDevices.slice(0, 25)) {
        try {
          const wrapped = await wrapConversationKey({
            conversationId,
            materialB64: material,
            recipientPublicJwk: JSON.parse(device.publicKey) as JsonWebKey,
          });
          grants.push({ deviceId: device.deviceId, ...wrapped });
        } catch {
          // Ignore stale or incompatible devices; this browser can still send.
        }
      }
      if (grants.length > 0) {
        await apiFetch(`/api/conversations/${conversationId}/keys`, { method: "POST", body: { grants } }).catch(
          () => undefined,
        );
      }
    }

    return { keys, ready: Boolean(material) };
  }, []);

  const decryptBatch = useCallback(async (items: MessageDto[]): Promise<ChatMessage[]> => {
    const output: ChatMessage[] = [];
    for (const item of items) {
      if (item.contentType === "system" || item.deletedAt) {
        output.push({ ...item });
        continue;
      }
      const known = plaintextRef.current.get(item.id);
      if (known !== undefined) {
        output.push({ ...item, plaintext: known });
        continue;
      }
      try {
        const text = await decryptText(item.conversationId, item.ciphertext, item.ciphertextIv);
        plaintextRef.current.set(item.id, text);
        output.push({ ...item, plaintext: text });
      } catch {
        output.push({ ...item });
      }
    }
    return output;
  }, []);

  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
    setMessages((previous) => {
      const map = new Map(previous.map((message) => [message.id, message]));
      for (const message of incoming) {
        const existing = map.get(message.id);
        map.set(message.id, existing ? { ...existing, ...message } : message);
      }
      return [...map.values()].sort((a, b) => a.serverTimestamp.localeCompare(b.serverTimestamp));
    });
  }, []);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      const payload = await apiFetch<MessagesResponse>(
        `/api/conversations/${conversationId}/messages?markRead=1`,
      );
      const decrypted = await decryptBatch(payload.messages);
      const mapped = new Map(decrypted.map((message) => [message.id, message]));
      setMessages([...mapped.values()]);
      setTyping(payload.typing);
    },
    [decryptBatch],
  );

  const loadConversation = useCallback(
    async (conversationId: string) => {
      setActiveId(conversationId);
      setDetail(null);
      setMessages([]);
      setKeyState({ status: "loading", pending: 0 });
      setMobilePane("thread");
      try {
        const { keys, ready } = await resolveKeys(conversationId);
        setKeyState({
          status: ready ? "ready" : "waiting",
          pending: keys.pendingDevices.length,
          message: ready ? undefined : "Waiting for a key-holding device to grant this browser access.",
        });
        const detailPayload = await apiFetch<ConversationDetail>(`/api/conversations/${conversationId}`);
        setDetail(detailPayload);
        setTyping(detailPayload.typing);
        if (ready) await loadMessages(conversationId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "This channel could not be opened.");
        setKeyState({ status: "error", pending: 0 });
      }
    },
    [loadMessages, resolveKeys],
  );

  const refreshConversations = useCallback(async () => {
    try {
      const payload = await apiFetch<{ conversations: ConversationSummary[] }>("/api/conversations");
      setConversations(payload.conversations);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadConversation(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const timer = window.setInterval(async () => {
      try {
        if (keyState.status === "waiting" || keyState.status === "error") {
          const { ready } = await resolveKeys(activeId);
          if (ready) {
            setKeyState({ status: "ready", pending: 0 });
            await loadMessages(activeId);
          }
          return;
        }
        const cursor = messages.length > 0 ? messages[messages.length - 1].serverTimestamp : null;
        const query = cursor ? `?after=${encodeURIComponent(cursor)}&markRead=1` : "?markRead=1";
        const payload = await apiFetch<MessagesResponse>(`/api/conversations/${activeId}/messages${query}`);
        if (payload.messages.length > 0) mergeMessages(await decryptBatch(payload.messages));
        setTyping(payload.typing);
      } catch {
        /* keep polling */
      }
    }, 3500);
    return () => window.clearInterval(timer);
  }, [activeId, keyState.status, messages, decryptBatch, loadMessages, mergeMessages, resolveKeys]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshConversations();
      if (activeId) {
        apiFetch<ConversationDetail>(`/api/conversations/${activeId}`)
          .then((payload) => setDetail(payload))
          .catch(() => undefined);
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [activeId, refreshConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, activeId]);

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !activeId) return;
    const clientMessageId = localId();
    const localKey = `local:${clientMessageId}`;
    setDraft("");
    try {
      const { ciphertext, ciphertextIv } = await encryptText(activeId, text);
      const optimistic: ChatMessage = {
        id: localKey,
        conversationId: activeId,
        senderId: me.id,
        senderName: me.name,
        senderDeviceId: "this-device",
        clientMessageId,
        contentType: "text",
        ciphertext: "",
        ciphertextIv: "",
        systemText: null,
        replyToId: null,
        status: "sending",
        serverTimestamp: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        recipientCount: 0,
        deliveredCount: 0,
        readCount: 0,
        attachment: null,
        plaintext: text,
        localPending: true,
      };
      mergeMessages([optimistic]);
      void apiFetch(`/api/conversations/${activeId}/state`, { method: "POST", body: { action: "stop_typing" } });

      const result = await apiFetch<{ messageId: string; serverTimestamp: string }>(
        `/api/conversations/${activeId}/messages`,
        {
          method: "POST",
          body: { clientMessageId, ciphertext, ciphertextIv, contentType: "text" },
        },
      );
      plaintextRef.current.set(result.messageId, text);
      setMessages((previous) =>
        previous.map((message) =>
          message.id === localKey
            ? {
                ...message,
                id: result.messageId,
                ciphertext,
                ciphertextIv,
                status: "sent",
                serverTimestamp: result.serverTimestamp,
                localPending: false,
              }
            : message,
        ),
      );
      void refreshConversations();
    } catch (caught) {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === localKey ? { ...message, localFailed: true, localPending: false } : message,
        ),
      );
      setError(caught instanceof ApiClientError ? caught.message : "The message could not be delivered.");
    }
  }

  async function sendAttachment(file: File) {
    if (!activeId) return;
    if (file.size > 1_200_000) {
      setError("Files larger than 1.2 MB are not supported in this build.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const storedPayload = await encryptFile(activeId, bytes);
      const { ciphertext, ciphertextIv } = await encryptText(activeId, `Shared a file: ${file.name}`);
      const clientMessageId = localId();
      await apiFetch(`/api/conversations/${activeId}/messages`, {
        method: "POST",
        body: {
          clientMessageId,
          ciphertext,
          ciphertextIv,
          contentType: file.type.startsWith("image/") ? "image" : "file",
          attachment: {
            fileName: file.name,
            fileSizeBytes: file.size,
            mimeType: file.type || "application/octet-stream",
            storedPayload,
          },
        },
      });
      setBanner(`Encrypted attachment “${file.name}” sent.`);
      await loadMessages(activeId);
      void refreshConversations();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "The attachment could not be encrypted.");
    }
  }

  async function openAttachment(message: ChatMessage) {
    if (!message.attachment || attachmentUrls[message.attachment.id]) return;
    try {
      const payload = await apiFetch<{ storedPayload: string; fileName: string; mimeType: string }>(
        `/api/attachments/${message.attachment.id}`,
      );
      const bytes = await decryptFile(message.conversationId, payload.storedPayload);
      const blob = new Blob([bytes as unknown as BlobPart], { type: payload.mimeType });
      setAttachmentUrls((previous) => ({ ...previous, [message.attachment!.id]: URL.createObjectURL(blob) }));
    } catch {
      setError("The attachment could not be decrypted on this device.");
    }
  }

  async function conversationAction(action: "mute" | "unmute" | "archive" | "unarchive" | "leave") {
    if (!activeId) return;
    try {
      await apiFetch(`/api/conversations/${activeId}/state`, { method: "POST", body: { action } });
      setBanner(`Channel ${action === "leave" ? "left" : `${action}d`}.`);
      await refreshConversations();
      if (action === "leave") {
        setActiveId(null);
        setMessages([]);
        setDetail(null);
        setMobilePane("list");
      } else {
        await loadConversation(activeId);
      }
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "That action is not permitted.");
    }
  }

  async function startDirectChat(personId: string) {
    try {
      const payload = await apiFetch<{ conversationId: string }>("/api/conversations", {
        method: "POST",
        body: { type: "direct", memberIds: [personId] },
      });
      setNewChatOpen(false);
      await refreshConversations();
      await loadConversation(payload.conversationId);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "The channel could not be created.");
    }
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    if (!activeId) return;
    const now = Date.now();
    if (now - typingSentRef.current > 3000) {
      typingSentRef.current = now;
      void apiFetch(`/api/conversations/${activeId}/state`, { method: "POST", body: { action: "typing" } }).catch(
        () => undefined,
      );
    }
  }

  async function submitReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reportOpen) return;
    const form = new FormData(event.currentTarget);
    try {
      await apiFetch("/api/reports", {
        method: "POST",
        body: {
          targetType: "message",
          targetId: reportOpen.id,
          reason: String(form.get("reason") ?? "Other safety concern"),
          description: String(form.get("description") ?? ""),
          submittedContent: String(form.get("submittedContent") ?? "") || undefined,
        },
      });
      setBanner("Report submitted. A moderator will review any excerpt you shared.");
      setReportOpen(null);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : "The report could not be submitted.");
    }
  }

  return (
    <div className="flex h-[calc(100vh-57px)] min-h-0">
      {/* ── conversation list ── */}
      <section
        className={`flex w-full min-w-0 flex-col border-r border-white/10 lg:w-80 lg:shrink-0 ${
          mobilePane === "thread" ? "hidden lg:flex" : "flex"
        }`}
      >
        <div className="space-y-3 border-b border-white/10 p-3">
          <div className="flex gap-2">
            <input
              className="field"
              placeholder="Search channels and people"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              aria-label="Search channels"
            />
            <button type="button" className="btn-primary shrink-0" onClick={() => setNewChatOpen(true)}>
              New
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Message bodies are end-to-end encrypted — search covers channel names, member names and
            the directory only.
          </p>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto">
          {filteredConversations.length === 0 ? (
            <li className="p-4 text-sm text-slate-500">
              No channels yet. Use <strong className="text-slate-300">New</strong> to open an encrypted
              channel with a provisioned member.
            </li>
          ) : (
            filteredConversations.map((conversation) => {
              const others = conversation.members.filter((member) => member.id !== me.id);
              const online = others.some((member) => member.online);
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => void loadConversation(conversation.id)}
                    className={`flex w-full items-start gap-3 border-b border-white/5 px-3 py-3 text-left transition hover:bg-white/[0.04] ${
                      conversation.id === activeId ? "bg-white/[0.06]" : ""
                    }`}
                  >
                    <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-glow-500)]/25 text-xs font-semibold text-[color:var(--color-glow-400)]">
                      {conversation.type === "group" ? "◍" : (others[0]?.initials ?? "·")}
                      {online ? (
                        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--color-ink-950)] bg-[color:var(--color-mint-400)]" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-slate-100">{conversation.title}</span>
                        {conversation.unreadCount > 0 ? (
                          <span className="rounded-full bg-[color:var(--color-rose-400)] px-1.5 text-[10px] font-bold text-[color:var(--color-ink-950)]">
                            {conversation.unreadCount}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                        <span className="truncate">
                          {conversation.lastMessage
                            ? `${conversation.lastMessage.contentType === "system" ? "Channel update" : "Encrypted message"} · ${formatRelativeTime(conversation.lastMessage.serverTimestamp)}`
                            : "No messages yet"}
                        </span>
                      </span>
                      <span className="mt-1 flex gap-1">
                        <span className={conversation.hasConversationKey ? "chip-ok" : "chip-warn"}>
                          {conversation.hasConversationKey ? "key held" : "no key"}
                        </span>
                        <span className="chip">{conversation.type}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </section>

      {/* ── thread ── */}
      <section className={`flex min-w-0 flex-1 flex-col ${mobilePane === "list" ? "hidden lg:flex" : "flex"}`}>
        {error ? (
          <div role="alert" className="flex items-center gap-2 border-b border-rose-400/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            <span className="flex-1">{error}</span>
            <button type="button" className="btn-quiet text-xs" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {banner ? (
          <div className="flex items-center gap-2 border-b border-emerald-400/20 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-200">
            <span className="flex-1">{banner}</span>
            <button type="button" className="btn-quiet text-xs" onClick={() => setBanner(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {!activeConversation || !activeId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-lg font-medium text-slate-200">Select a channel</p>
            <p className="max-w-sm text-sm text-slate-500">
              Channels are provisioned by administrators or opened with members you already share a
              group with. Every message is encrypted on this device before it leaves the browser.
            </p>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
              <button
                type="button"
                className="btn-quiet lg:hidden"
                onClick={() => setMobilePane("list")}
                aria-label="Back to channels"
              >
                ←
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-sm font-semibold text-white">{activeConversation.title}</h1>
                <p className="truncate text-xs text-slate-500">
                  {detail
                    ? `${detail.members.length} members · ${detail.members.filter((m) => m.online).length} online · ${detail.conversation.policy.announcementOnly ? "announcement-only" : "open"}`
                    : "Loading channel…"}
                </p>
              </div>
              {activeConversation.groupId ? <div className="flex shrink-0 gap-1">
                {activeMeeting ? <><button type="button" className="btn-primary text-xs" onClick={() => window.location.assign(`/app/groups/${activeConversation.groupId}/video-call/${activeMeeting.id}`)}>● Live call · Join</button><button type="button" className="btn-ghost text-xs" onClick={() => void restartMeeting()}>Restart</button></> : <>
                  <button type="button" className="btn-ghost text-xs" onClick={() => void startMeeting("voice")}>Voice call</button>
                  <button type="button" className="btn-primary text-xs" onClick={() => void startMeeting("video")}>Video call</button>
                </>}
              </div> : null}
              <span
                className={
                  keyState.status === "ready"
                    ? "chip-ok"
                    : keyState.status === "waiting"
                      ? "chip-warn"
                      : "chip-info"
                }
                title={keyState.message ?? "Conversation key available on this device"}
              >
                {keyState.status === "ready"
                  ? "E2EE active"
                  : keyState.status === "waiting"
                    ? "awaiting key"
                    : keyState.status === "loading"
                      ? "provisioning"
                      : "no key"}
              </span>
              <div className="relative">
                <details className="group">
                  <summary className="btn-ghost cursor-pointer list-none">Channel</summary>
                  <div className="absolute right-0 z-20 mt-2 w-56 panel p-2 text-sm">
                    <button
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-left text-slate-300 hover:bg-white/[0.06]"
                      onClick={() => void conversationAction(detail?.membership.mutedUntil ? "unmute" : "mute")}
                    >
                      {detail?.membership.mutedUntil ? "Unmute notifications" : "Mute for 8 hours"}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-left text-slate-300 hover:bg-white/[0.06]"
                      onClick={() => void conversationAction(detail?.membership.archived ? "unarchive" : "archive")}
                    >
                      {detail?.membership.archived ? "Unarchive channel" : "Archive channel"}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-left text-rose-200 hover:bg-rose-500/10"
                      onClick={() => void conversationAction("leave")}
                    >
                      Leave channel
                    </button>
                  </div>
                </details>
              </div>
            </header>

            {keyState.status !== "ready" ? (
              <div className="border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-200">
                {keyState.status === "loading"
                  ? "Provisioning the conversation key for this browser…"
                  : keyState.status === "waiting"
                    ? "This browser does not hold the conversation key yet. Any member device that holds it will grant access automatically; messages stay encrypted meanwhile."
                    : keyState.message}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <p className="text-center text-sm text-slate-500">
                  No messages yet. Say hello — the first message is encrypted on your device.
                </p>
              ) : (
                messages.map((message) => {
                  if (message.contentType === "system") {
                    return (
                      <p key={message.id} className="text-center text-xs text-slate-500">
                        {message.systemText}
                      </p>
                    );
                  }
                  const mine = message.senderId === me.id;
                  const deleted = Boolean(message.deletedAt);
                  return (
                    <div key={message.id} className={`fade-in flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[min(640px,85%)] ${mine ? "items-end" : "items-start"}`}>
                        {!mine ? (
                          <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            {message.senderName}
                          </p>
                        ) : null}
                        <div
                          className={`message-bubble rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                            mine
                              ? "bg-[color:var(--color-glow-500)]/85 text-white"
                              : "border border-white/10 bg-white/[0.05] text-slate-100"
                          }`}
                        >
                          {deleted ? (
                            <em className="text-slate-300">This message was deleted.</em>
                          ) : message.contentType === "system" ? null : message.plaintext !== undefined ? (
                            <span className="whitespace-pre-wrap break-words">{message.plaintext}</span>
                          ) : (
                            <span className="text-xs text-slate-300">
                              🔒 Ciphertext — waiting for this device&apos;s key to decrypt.
                            </span>
                          )}

                          {message.attachment ? (
                            <div className="mt-2 rounded-lg border border-white/15 bg-black/20 p-2">
                              {attachmentUrls[message.attachment.id] &&
                              message.attachment.mimeType.startsWith("image/") ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={attachmentUrls[message.attachment.id]}
                                  alt={message.attachment.fileName}
                                  className="max-h-64 rounded"
                                />
                              ) : (
                                <button
                                  type="button"
                                  className="btn-ghost w-full text-xs"
                                  onClick={() => void openAttachment(message)}
                                >
                                  🔒 Decrypt &amp; open {message.attachment.fileName} (
                                  {Math.round(message.attachment.fileSizeBytes / 1024)} KB)
                                </button>
                              )}
                            </div>
                          ) : null}

                          <span
                            className={`mt-1 flex items-center gap-2 text-[11px] ${
                              mine ? "text-white/75" : "text-slate-500"
                            }`}
                          >
                            {formatClock(message.serverTimestamp)}
                            {message.editedAt ? " · edited" : ""}
                            {mine ? ` · ${statusGlyph(message)}` : ""}
                          </span>
                        </div>
                        {!deleted && !mine ? (
                          <button
                            type="button"
                            className="mt-1 px-1 text-[11px] text-slate-500 hover:text-rose-200"
                            onClick={() => setReportOpen(message)}
                          >
                            Report
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {typing.length > 0 ? (
              <p className="px-4 pb-1 text-xs text-slate-400">
                {typing.map((entry) => entry.name).join(", ")} {typing.length === 1 ? "is" : "are"} typing…
              </p>
            ) : null}

            <form
              className="flex items-end gap-2 border-t border-white/10 px-3 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
            >
              <label className="btn-ghost cursor-pointer" title="Attach an encrypted file">
                📎
                <input
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void sendAttachment(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <textarea
                className="field max-h-32 min-h-[42px] flex-1 resize-y"
                placeholder={
                  keyState.status === "ready"
                    ? "Write an encrypted message…"
                    : "Unlock this channel before sending…"
                }
                value={draft}
                rows={1}
                disabled={keyState.status !== "ready"}
                onChange={(event) => handleDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                aria-label="Message"
              />
              <button type="submit" className="btn-primary" disabled={keyState.status !== "ready" || !draft.trim()}>
                Send
              </button>
            </form>
          </>
        )}
      </section>

      {/* ── new chat panel ── */}
      {newChatOpen ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
          <div className="panel w-full max-w-lg p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Open an encrypted channel</h2>
              <button type="button" className="btn-quiet" onClick={() => setNewChatOpen(false)}>
                Close
              </button>
            </div>
            <input
              className="field mt-3"
              placeholder="Filter provisioned members"
              value={peopleQuery}
              onChange={(event) => setPeopleQuery(event.target.value)}
            />
            <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
              {filteredPeople.length === 0 ? (
                <li className="text-sm text-slate-500">
                  No members match. You can only message peers who share a group with you unless a
                  staff member has directory visibility.
                </li>
              ) : (
                filteredPeople.map((person) => (
                  <li key={person.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/[0.06]"
                      onClick={() => void startDirectChat(person.id)}
                    >
                      <span>
                        <span className="block text-sm text-slate-100">{person.name}</span>
                        <span className="block text-xs text-slate-500">
                          {person.email} · {person.userType}
                        </span>
                      </span>
                      <span className="chip">message</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}

      {/* ── report dialog ── */}
      {reportOpen ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
          <form onSubmit={submitReport} className="panel w-full max-w-lg p-5">
            <h2 className="text-base font-semibold text-white">Report a message</h2>
            <p className="mt-1 text-xs text-slate-500">
              The server cannot read this message. Only the excerpt you paste below is visible to
              moderators.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="label" htmlFor="reason">
                  Reason
                </label>
                <select id="reason" name="reason" className="field" defaultValue={REPORT_REASONS[0]}>
                  {REPORT_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {reason}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="description">
                  What happened?
                </label>
                <textarea id="description" name="description" rows={3} className="field" />
              </div>
              <div>
                <label className="label" htmlFor="submittedContent">
                  Optional excerpt (paste the text you want reviewed)
                </label>
                <textarea
                  id="submittedContent"
                  name="submittedContent"
                  rows={3}
                  className="field"
                  defaultValue={plaintextRef.current.get(reportOpen.id) ?? ""}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setReportOpen(null)}>
                Cancel
              </button>
              <button type="submit" className="btn-danger">
                Submit report
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
