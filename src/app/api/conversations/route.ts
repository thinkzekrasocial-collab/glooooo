/**
 * GET  /api/conversations — channels the caller belongs to (metadata + unread counts).
 * POST /api/conversations — provision a direct or group channel.
 *
 * Channel provisioning is operator-controlled: 1:1 channels honour the platform
 * direct-messaging policy, group channels require group visibility permission
 * (TRD §10).
 */
import { NextRequest } from "next/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  blockedUsers,
  conversationMembers,
  conversations,
  groupMembers,
  groups,
  messages,
  platformSettings,
  users,
} from "@/db/schema";
import { notifyUser, recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { uuid } from "@/lib/crypto";
import { fullName, listConversationsForUser } from "@/lib/data";
import {
  ApiError,
  enforceRateLimit,
  enumValue,
  jsonOk,
  readJson,
  route,
  str,
  stringArray,
} from "@/lib/http";
import { hasPermission, PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, meta) => {
  const session = await requireUser();
  const rows = await listConversationsForUser(session.id, session.deviceId);
  return jsonOk({ conversations: rows }, meta);
});

export const POST = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  enforceRateLimit(`conversation:create:${session.id}`, 20, 60_000);

  const body = await readJson(req);
  const type = enumValue(body, "type", ["direct", "group"] as const, { required: true })!;

  if (type === "direct") {
    const settings = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, "messaging.direct_messaging_enabled"))
      .limit(1);
    if (settings[0]?.value === false) {
      throw new ApiError("POLICY_DIRECT_MESSAGING_DISABLED", "Direct messaging is disabled by policy.", 403);
    }

    const memberIds = stringArray(body, "memberIds", { required: true, maxItems: 1 })!;
    const targetId = memberIds[0];
    if (!targetId || targetId === session.id) {
      throw new ApiError("VALIDATION_SELF_CONVERSATION", "Choose another member to message.", 422);
    }

    const targetRows = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    const target = targetRows[0];
    if (!target || target.status !== "active" || target.deletedAt) {
      throw new ApiError("USER_NOT_AVAILABLE", "That account is not available for messaging.", 404);
    }

    const blocked = await db
      .select({ blockerId: blockedUsers.blockerId })
      .from(blockedUsers)
      .where(
        or(
          and(eq(blockedUsers.blockerId, targetId), eq(blockedUsers.blockedId, session.id)),
          and(eq(blockedUsers.blockerId, session.id), eq(blockedUsers.blockedId, targetId)),
        ),
      )
      .limit(1);
    if (blocked.length > 0) {
      throw new ApiError("POLICY_BLOCKED", "A block exists between these accounts.", 403);
    }

    const existing = await db.execute(sql`
      select c.id
      from conversations c
      where c.type = 'direct'
        and c.status = 'active'
        and exists (
          select 1 from conversation_members a
          where a.conversation_id = c.id and a.user_id = ${session.id} and a.left_at is null
        )
        and exists (
          select 1 from conversation_members b
          where b.conversation_id = c.id and b.user_id = ${targetId} and b.left_at is null
        )
      limit 1
    `);
    const existingRow = existing.rows[0] as { id?: string } | undefined;
    if (existingRow?.id) {
      return jsonOk({ conversationId: existingRow.id, created: false }, meta);
    }

    const conversationId = uuid();
    await db.insert(conversations).values({
      id: conversationId,
      type: "direct",
      createdBy: session.id,
    });
    await db.insert(conversationMembers).values([
      { conversationId, userId: session.id, role: "owner" },
      { conversationId, userId: targetId, role: "participant" },
    ]);
    await db.insert(messages).values({
      id: uuid(),
      conversationId,
      senderId: session.id,
      senderDeviceId: session.deviceId ?? "system",
      clientMessageId: uuid(),
      contentType: "system",
      ciphertext: "",
      ciphertextIv: "",
      systemText: `Encrypted channel opened by ${fullName({ firstName: session.firstName, lastName: session.lastName })}.`,
      status: "sent",
    });

    await notifyUser({
      userId: targetId,
      type: "system",
      title: "New encrypted channel",
      body: "A secure channel was created with you. Messages stay end-to-end encrypted.",
      data: { deepLink: `/app?c=${conversationId}`, conversationId },
    });
    await recordAudit({
      eventType: "conversation.created",
      actorId: session.id,
      actorRole: session.roles.join(","),
      action: "create",
      targetType: "conversation",
      targetId: conversationId,
      details: { type: "direct", members: [session.id, targetId] },
      ipAddress: meta.ip,
      correlationId: meta.requestId,
    });

    return jsonOk({ conversationId, created: true }, meta, 201);
  }

  // ── group channel ──
  if (
    !hasPermission(session.permissions, PERMISSIONS.groupsView) &&
    !hasPermission(session.permissions, PERMISSIONS.groupsManageMembers)
  ) {
    throw new ApiError(
      "AUTH_FORBIDDEN",
      "Only staff with group visibility can provision group channels.",
      403,
    );
  }

  const groupId = str(body, "groupId", { required: true, max: 64 })!;
  const groupRows = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .limit(1);
  const group = groupRows[0];
  if (!group) throw new ApiError("GROUP_NOT_FOUND", "Group not found.", 404);
  if (group.status !== "active") {
    throw new ApiError("GROUP_NOT_ACTIVE", "Only active groups can host a channel.", 409);
  }

  const roster = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        isNull(groupMembers.removedAt),
        eq(users.status, "active"),
        isNull(users.deletedAt),
      ),
    );

  const requested = stringArray(body, "memberIds");
  const rosterIds = new Set(roster.map((r) => r.userId));
  const memberIds = (requested ?? roster.map((r) => r.userId)).filter(
    (id) => rosterIds.has(id) || id === session.id,
  );
  if (!memberIds.includes(session.id)) memberIds.push(session.id);
  const uniqueMemberIds = [...new Set(memberIds)];
  if (uniqueMemberIds.length < 2) {
    throw new ApiError("VALIDATION_MEMBERS_REQUIRED", "A group channel needs at least two members.", 422);
  }
  if (group.maxMembers && uniqueMemberIds.length > group.maxMembers) {
    throw new ApiError("GROUP_MEMBER_LIMIT", `This group allows at most ${group.maxMembers} members.`, 422);
  }

  const conversationId = uuid();
  await db.insert(conversations).values({
    id: conversationId,
    type: "group",
    groupId,
    title: group.name,
    createdBy: session.id,
    lastMessageAt: new Date(),
  });
  await db.insert(conversationMembers).values(
    uniqueMemberIds.map((userId) => ({
      conversationId,
      userId,
      role: userId === session.id ? "owner" : "participant",
    })),
  );
  await db.insert(messages).values({
    id: uuid(),
    conversationId,
    senderId: session.id,
    senderDeviceId: session.deviceId ?? "system",
    clientMessageId: uuid(),
    contentType: "system",
    ciphertext: "",
    ciphertextIv: "",
    systemText: `Group channel provisioned for ${group.name}. End-to-end encryption is enabled for all members.`,
    status: "sent",
  });

  for (const userId of uniqueMemberIds) {
    if (userId === session.id) continue;
    await notifyUser({
      userId,
      type: "system",
      title: `Added to ${group.name}`,
      body: "You were added to a group channel. Messages are end-to-end encrypted.",
      data: { deepLink: `/app?c=${conversationId}`, conversationId },
    });
  }
  await recordAudit({
    eventType: "conversation.created",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "create",
    targetType: "conversation",
    targetId: conversationId,
    details: { type: "group", groupId, members: uniqueMemberIds.length },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ conversationId, created: true }, meta, 201);
});
