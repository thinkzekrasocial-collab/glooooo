/**
 * GET  /api/conversations/:id/messages — ciphertext page + delivery acknowledgement.
 * POST /api/conversations/:id/messages — persist a client-encrypted message.
 *
 * The API never accepts plaintext: the body carries an AES-256-GCM ciphertext
 * plus IV produced in the browser (TRD §7, §11).
 */
import { NextRequest } from "next/server";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  conversationMembers,
  conversations,
  devices,
  groups,
  messageRecipients,
  messages,
} from "@/db/schema";
import { notifyUser, recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { sha256, uuid } from "@/lib/crypto";
import { fullName, isConversationMember, listMessages, listTypingUsers, rawRows } from "@/lib/data";
import {
  ApiError,
  clampLimit,
  enforceRateLimit,
  enumValue,
  intValue,
  jsonOk,
  readJson,
  route,
  str,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function recomputeStatuses(messageIds: string[]) {
  if (messageIds.length === 0) return;
  await db.execute(sql`
    update messages m
    set status = case
      when exists (
        select 1 from message_recipients r
        where r.message_id = m.id and r.read_at is not null
      ) and not exists (
        select 1 from message_recipients r
        where r.message_id = m.id and r.read_at is null
      ) then 'read'
      when exists (
        select 1 from message_recipients r
        where r.message_id = m.id and r.delivered_at is not null
      ) and not exists (
        select 1 from message_recipients r
        where r.message_id = m.id and r.delivered_at is null
      ) then 'delivered'
      else 'sent'
    end
    where m.id in (${sql.join(
      messageIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
}

export const GET = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;
  if (!(await isConversationMember(session.id, id))) {
    throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
  }

  const url = new URL(req.url);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const limit = clampLimit(url.searchParams.get("limit"), 60, 200);
  const markRead = url.searchParams.get("markRead") === "1";

  const list = await listMessages(id, {
    limit,
    before: before ? new Date(before) : null,
    after: after ? new Date(after) : null,
  });

  const incomingIds = list.filter((m) => m.senderId !== session.id).map((m) => m.id);
  if (incomingIds.length > 0) {
    await db
      .update(messageRecipients)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          eq(messageRecipients.userId, session.id),
          inArray(messageRecipients.messageId, incomingIds),
          isNull(messageRecipients.deliveredAt),
        ),
      );

    if (markRead) {
      await db
        .update(messageRecipients)
        .set({ readAt: new Date(), deliveredAt: sql`coalesce(${messageRecipients.deliveredAt}, now())` })
        .where(
          and(
            eq(messageRecipients.userId, session.id),
            inArray(messageRecipients.messageId, incomingIds),
            isNull(messageRecipients.readAt),
          ),
        );
      await db
        .update(conversationMembers)
        .set({ lastReadAt: new Date() })
        .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, session.id)));
    }
    await recomputeStatuses(incomingIds);
  }

  const cursors = await rawRows<{ user_id: string; last_read_at: string | null }>(sql`
    select user_id, last_read_at from conversation_members
    where conversation_id = ${id} and left_at is null
  `);

  return jsonOk(
    {
      messages: list,
      typing: await listTypingUsers(id, session.id),
      readCursors: cursors.map((c) => ({ userId: c.user_id, lastReadAt: c.last_read_at })),
      serverTime: new Date().toISOString(),
    },
    meta,
  );
});

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;
  enforceRateLimit(`message:send:${session.id}`, 60, 60_000);

  const memberRows = await db
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, id),
        eq(conversationMembers.userId, session.id),
        isNull(conversationMembers.leftAt),
      ),
    )
    .limit(1);
  if (memberRows.length === 0) {
    throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
  }

  const conversationRows = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  const conversation = conversationRows[0];
  if (!conversation) throw new ApiError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);
  if (conversation.status !== "active") {
    throw new ApiError("CONVERSATION_ARCHIVED", "This conversation is archived.", 409);
  }

  let fileSharingAllowed = true;

  if (conversation.groupId) {
    const groupRows = await db.select().from(groups).where(eq(groups.id, conversation.groupId)).limit(1);
    const group = groupRows[0];
    if (group?.announcementOnly) {
      const groupMember = await db.execute(sql`
        select 1 from group_members
        where group_id = ${group.id} and user_id = ${session.id} and member_role = 'admin' and removed_at is null
        limit 1
      `);
      if (groupMember.rows.length === 0) {
        throw new ApiError(
          "POLICY_ANNOUNCEMENT_ONLY",
          "This channel is announcement-only. Only group admins can post.",
          403,
        );
      }
    }
    fileSharingAllowed = group ? group.fileSharingEnabled : true;
  }

  const body = await readJson(req);
  const clientMessageId = str(body, "clientMessageId", { required: true, max: 64, label: "Client message id" })!;
  const ciphertext = str(body, "ciphertext", { required: true, max: 1_400_000, label: "Ciphertext" })!;
  const ciphertextIv = str(body, "ciphertextIv", { required: true, max: 64, label: "Initialisation vector" })!;
  const contentType = enumValue(body, "contentType", ["text", "file", "image", "audio"] as const) ?? "text";
  const replyToId = str(body, "replyToId", { max: 64 });
  const attachmentBody = body.attachment;

  const existing = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, id), eq(messages.clientMessageId, clientMessageId)))
    .limit(1);
  if (existing[0]) {
    return jsonOk({ messageId: existing[0].id, deduplicated: true }, meta);
  }

  const messageId = uuid();
  await db.insert(messages).values({
    id: messageId,
    conversationId: id,
    senderId: session.id,
    senderDeviceId: session.deviceId ?? "unknown-device",
    clientMessageId,
    contentType,
    ciphertext,
    ciphertextIv,
    contentHash: sha256(ciphertext + ciphertextIv),
    replyToId: replyToId ?? null,
    status: "sent",
  });

  let attachmentRecord: { id: string; fileName: string } | null = null;
  if (attachmentBody && typeof attachmentBody === "object") {
    if (!fileSharingAllowed) {
      throw new ApiError("POLICY_FILE_SHARING_DISABLED", "File sharing is disabled for this channel.", 403);
    }
    const att = attachmentBody as Record<string, unknown>;
    const fileName = str(att, "fileName", { required: true, max: 200, label: "File name" })!;
    const mimeType = str(att, "mimeType", { required: true, max: 160, label: "Mime type" })!;
    const storedPayload = str(att, "storedPayload", { required: true, max: 1_400_000, label: "Encrypted file" })!;
    const checksum = str(att, "checksumSha256", { max: 128 }) ?? sha256(storedPayload);
    const size = intValue(att, "fileSizeBytes", { min: 1, max: 20_000_000 }) ?? storedPayload.length;
    const attachmentId = uuid();
    await db.insert(attachments).values({
      id: attachmentId,
      messageId,
      uploaderId: session.id,
      fileName,
      fileSizeBytes: size,
      mimeType,
      r2Key: `encrypted/${messageId}/${attachmentId}`,
      storedPayload,
      scanStatus: "clean",
      scanCompletedAt: new Date(),
      checksumSha256: checksum,
    });
    attachmentRecord = { id: attachmentId, fileName };
  }

  const recipientRows = await db
    .select({ userId: conversationMembers.userId, deviceId: devices.id })
    .from(conversationMembers)
    .leftJoin(devices, and(eq(devices.userId, conversationMembers.userId), eq(devices.status, "active")))
    .where(
      and(
        eq(conversationMembers.conversationId, id),
        isNull(conversationMembers.leftAt),
        ne(conversationMembers.userId, session.id),
      ),
    );

  const recipientsByUser = new Map<string, string[]>();
  for (const row of recipientRows) {
    const list = recipientsByUser.get(row.userId) ?? [];
    if (row.deviceId) list.push(row.deviceId);
    recipientsByUser.set(row.userId, list);
  }

  const recipientValues = [...recipientsByUser.entries()].flatMap(([userId, deviceIds]) =>
    deviceIds.length > 0
      ? deviceIds.map((deviceId) => ({ messageId, userId, deviceId }))
      : [{ messageId, userId, deviceId: "pending" }],
  );
  if (recipientValues.length > 0) {
    await db.insert(messageRecipients).values(recipientValues).onConflictDoNothing();
  }

  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, id));

  const senderName = fullName({
    firstName: session.firstName,
    lastName: session.lastName,
    preferredName: session.preferredName,
  });

  const muted = await db
    .select({ mutedUntil: conversationMembers.mutedUntil })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, id), isNull(conversationMembers.leftAt)));
  const mutedUsers = new Set(
    muted.filter((m) => m.mutedUntil && m.mutedUntil.getTime() > Date.now()).map(() => ""),
  );

  for (const userId of recipientsByUser.keys()) {
    if (mutedUsers.has(userId)) continue;
    await notifyUser({
      userId,
      type: "message",
      title: conversation.type === "direct" ? `${senderName}` : `${senderName} in ${conversation.title ?? "group channel"}`,
      body: "New encrypted message — open the app to decrypt.",
      data: { deepLink: `/app?c=${id}`, conversationId: id, messageId },
    });
  }

  await recordAudit({
    eventType: "message.sent",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "create",
    targetType: "message",
    targetId: messageId,
    details: {
      conversationId: id,
      contentType,
      hasAttachment: Boolean(attachmentRecord),
      recipients: recipientsByUser.size,
    },
    ipAddress: meta.ip,
    deviceId: session.deviceId,
    correlationId: meta.requestId,
  });

  return jsonOk(
    {
      messageId,
      clientMessageId,
      status: "sent",
      serverTimestamp: new Date().toISOString(),
      recipientCount: recipientsByUser.size,
      attachment: attachmentRecord,
    },
    meta,
    201,
  );
});
