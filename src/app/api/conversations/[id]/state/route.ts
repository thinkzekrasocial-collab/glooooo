/**
 * POST /api/conversations/:id/state — presence, typing, receipts and
 * per-member channel state (mute / archive / leave). Replaces the Durable
 * Object broadcast layer with an idempotent, poll-safe REST contract.
 */
import { NextRequest } from "next/server";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversationMembers, messageRecipients, messages, typingIndicators } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { isConversationMember } from "@/lib/data";
import {
  ApiError,
  enumValue,
  jsonOk,
  readJson,
  route,
  stringArray,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;
  if (!(await isConversationMember(session.id, id))) {
    throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
  }

  const body = await readJson(req);
  const action = enumValue(
    body,
    "action",
    ["typing", "stop_typing", "delivered", "read", "mute", "unmute", "archive", "unarchive", "leave"] as const,
    { required: true },
  )!;

  if (action === "typing" || action === "stop_typing") {
    if (action === "typing") {
      await db
        .insert(typingIndicators)
        .values({ conversationId: id, userId: session.id, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [typingIndicators.conversationId, typingIndicators.userId],
          set: { updatedAt: new Date() },
        });
    } else {
      await db
        .delete(typingIndicators)
        .where(and(eq(typingIndicators.conversationId, id), eq(typingIndicators.userId, session.id)));
    }
    return jsonOk({ ok: true, action }, meta);
  }

  if (action === "delivered" || action === "read") {
    const messageIds = stringArray(body, "messageIds") ?? [];
    const targetIds =
      messageIds.length > 0
        ? messageIds
        : (
            await db
              .select({ id: messages.id })
              .from(messages)
              .where(and(eq(messages.conversationId, id), ne(messages.senderId, session.id)))
              .orderBy(messages.serverTimestamp)
              .limit(500)
          ).map((row) => row.id);

    if (targetIds.length === 0) return jsonOk({ ok: true, acknowledged: 0 }, meta);

    if (action === "delivered") {
      const updated = await db
        .update(messageRecipients)
        .set({ deliveredAt: new Date() })
        .where(
          and(
            eq(messageRecipients.userId, session.id),
            inArray(messageRecipients.messageId, targetIds),
            isNull(messageRecipients.deliveredAt),
          ),
        )
        .returning({ messageId: messageRecipients.messageId });
      await recompute(targetIds);
      return jsonOk({ ok: true, acknowledged: updated.length }, meta);
    }

    const updated = await db
      .update(messageRecipients)
      .set({ readAt: new Date(), deliveredAt: sql`coalesce(${messageRecipients.deliveredAt}, now())` })
      .where(
        and(
          eq(messageRecipients.userId, session.id),
          inArray(messageRecipients.messageId, targetIds),
          isNull(messageRecipients.readAt),
        ),
      )
      .returning({ messageId: messageRecipients.messageId });

    await db
      .update(conversationMembers)
      .set({ lastReadAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, session.id)));

    await recompute(targetIds);
    return jsonOk({ ok: true, acknowledged: updated.length, readAt: new Date().toISOString() }, meta);
  }

  if (action === "mute" || action === "unmute") {
    const hours = Number(body.hours ?? 8);
    const mutedUntil = action === "mute" ? new Date(Date.now() + Math.min(Math.max(hours, 1), 720) * 3_600_000) : null;
    await db
      .update(conversationMembers)
      .set({ mutedUntil })
      .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, session.id)));
    await recordAudit({
      eventType: "conversation.mute_updated",
      actorId: session.id,
      action: "update",
      targetType: "conversation",
      targetId: id,
      details: { action },
      ipAddress: meta.ip,
      correlationId: meta.requestId,
    });
    return jsonOk({ ok: true, mutedUntil: mutedUntil ? mutedUntil.toISOString() : null }, meta);
  }

  if (action === "archive" || action === "unarchive") {
    await db
      .update(conversationMembers)
      .set({ archived: action === "archive" })
      .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, session.id)));
    return jsonOk({ ok: true, archived: action === "archive" }, meta);
  }

  // leave
  const memberRole = await db
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, session.id)))
    .limit(1);
  if (memberRole[0]?.role === "owner") {
    const owners = await db.execute(sql`
      select count(*)::int as count from conversation_members
      where conversation_id = ${id} and role = 'owner' and left_at is null
    `);
    const count = Number((owners.rows[0] as { count?: number } | undefined)?.count ?? 0);
    if (count <= 1 && !(await isStaff(session.permissions))) {
      throw new ApiError(
        "CONVERSATION_LAST_OWNER",
        "A channel owner cannot leave while they are the only owner. Ask an administrator.",
        409,
      );
    }
  }
  await db
    .update(conversationMembers)
    .set({ leftAt: new Date() })
    .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, session.id)));
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: id,
    senderId: session.id,
    senderDeviceId: session.deviceId ?? "system",
    clientMessageId: crypto.randomUUID(),
    contentType: "system",
    ciphertext: "",
    ciphertextIv: "",
    systemText: "A member left this channel.",
    status: "sent",
  });
  await recordAudit({
    eventType: "conversation.member_left",
    actorId: session.id,
    action: "delete",
    targetType: "conversation",
    targetId: id,
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  return jsonOk({ ok: true, left: true }, meta);
});

async function isStaff(permissions: string[]) {
  return permissions.includes("*") || permissions.includes("groups.view");
}

async function recompute(messageIds: string[]) {
  if (messageIds.length === 0) return;
  await db.execute(sql`
    update messages m
    set status = case
      when exists (select 1 from message_recipients r where r.message_id = m.id and r.read_at is not null)
       and not exists (select 1 from message_recipients r where r.message_id = m.id and r.read_at is null)
      then 'read'
      when exists (select 1 from message_recipients r where r.message_id = m.id and r.delivered_at is not null)
       and not exists (select 1 from message_recipients r where r.message_id = m.id and r.delivered_at is null)
      then 'delivered'
      else 'sent'
    end
    where m.id in (${sql.join(
      messageIds.map((messageId) => sql`${messageId}`),
      sql`, `,
    )})
  `);
}
