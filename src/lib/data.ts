/** Shared read helpers used by both route handlers and React Server Components. */
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  auditLogs,
  conversationMembers,
  conversations,
  devices,
  groupMembers,
  groups,
  invitations,
  messageRecipients,
  messages,
  notifications,
  platformSettings,
  reports,
  roles,
  securityEvents,
  sessions,
  typingIndicators,
  userPreferences,
  userRoles,
  users,
} from "@/db/schema";
import { hasPermission, PERMISSIONS } from "@/lib/rbac";

export type Row = Record<string, unknown>;

export async function rawRows<T = Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

export function fullName(user: { firstName: string; lastName: string; preferredName?: string | null }) {
  return user.preferredName?.trim() ? user.preferredName : `${user.firstName} ${user.lastName}`;
}

export function initials(user: { firstName: string; lastName: string }) {
  return `${user.firstName[0] ?? ""}${user.lastName[0] ?? ""}`.toUpperCase();
}

/* ─────────────────────────── directory ─────────────────────────── */

export type DirectoryEntry = {
  id: string;
  name: string;
  email: string;
  userType: string;
  status: string;
  department: string | null;
  gradeClass: string | null;
  program: string | null;
  roleNames: string[];
  sharedGroups: string[];
};

/**
 * Directory visibility: privileged roles see every active account; everyone
 * else only sees peers they already share a group or conversation with
 * (privacy default from user_preferences.privacy_settings.profile_visibility).
 */
export async function getDirectory(
  viewer: { id: string; permissions: string[] },
  search?: string,
  limit = 100,
): Promise<DirectoryEntry[]> {
  const privileged = hasPermission(viewer.permissions, PERMISSIONS.usersView);

  const base = db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      preferredName: users.preferredName,
      email: users.email,
      userType: users.userType,
      status: users.status,
      department: users.department,
      gradeClass: users.gradeClass,
      program: users.program,
      roleNames: sql<string[]>`coalesce(array_agg(distinct ${roles.name}) filter (where ${roles.name} is not null), '{}')`,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        ne(users.id, viewer.id),
        isNull(users.deletedAt),
        eq(users.status, "active"),
        search && search.trim().length > 0
          ? or(
              sql`${users.firstName} ilike ${`%${search.trim()}%`}`,
              sql`${users.lastName} ilike ${`%${search.trim()}%`}`,
              sql`${users.email} ilike ${`%${search.trim()}%`}`,
            )
          : undefined,
        privileged
          ? undefined
          : sql`exists (
              select 1 from group_members gm
              join group_members mine on mine.group_id = gm.group_id and mine.user_id = ${viewer.id}
              where gm.user_id = ${users.id}
                and gm.removed_at is null
                and mine.removed_at is null
            ) or exists (
              select 1 from conversation_members cm
              join conversation_members mine on mine.conversation_id = cm.conversation_id and mine.user_id = ${viewer.id}
              where cm.user_id = ${users.id}
                and cm.left_at is null
                and mine.left_at is null
            )`,
      ),
    )
    .groupBy(users.id)
    .orderBy(asc(users.firstName))
    .limit(limit);

  const rows = await base;
  return rows.map((row) => ({
    id: row.id,
    name: fullName(row),
    email: row.email,
    userType: row.userType,
    status: row.status,
    department: row.department,
    gradeClass: row.gradeClass,
    program: row.program,
    roleNames: row.roleNames ?? [],
    sharedGroups: [],
  }));
}

/* ─────────────────────────── conversations ─────────────────────────── */

export type ConversationSummary = {
  id: string;
  type: string;
  title: string | null;
  groupId: string | null;
  status: string;
  lastMessageAt: string | null;
  unreadCount: number;
  members: Array<{
    id: string;
    name: string;
    initials: string;
    userType: string;
    status: string;
    online: boolean;
  }>;
  lastMessage: {
    id: string;
    senderId: string;
    contentType: string;
    status: string;
    serverTimestamp: string;
  } | null;
  hasConversationKey: boolean;
  pendingKeyDevices: number;
};

export async function isConversationMember(userId: string, conversationId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function listConversationsForUser(
  userId: string,
  deviceId: string | null,
): Promise<ConversationSummary[]> {
  const convRows = await db
    .select({
      id: conversations.id,
      type: conversations.type,
      title: conversations.title,
      groupId: conversations.groupId,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, conversations.id),
        eq(conversationMembers.userId, userId),
      ),
    )
    .where(and(isNull(conversationMembers.leftAt), eq(conversations.status, "active")))
    .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`));

  if (convRows.length === 0) return [];
  const ids = convRows.map((c) => c.id);

  const memberRows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      preferredName: users.preferredName,
      userType: users.userType,
      status: users.status,
      lastActiveAt: sql<string | null>`max(${devices.lastActiveAt})`,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .leftJoin(devices, and(eq(devices.userId, users.id), eq(devices.status, "active")))
    .where(and(inArray(conversationMembers.conversationId, ids), isNull(conversationMembers.leftAt)))
    .groupBy(
      conversationMembers.conversationId,
      users.id,
      users.firstName,
      users.lastName,
      users.preferredName,
      users.userType,
      users.status,
    );

  const unreadRows = await rawRows<{ conversation_id: string; unread: number }>(sql`
    select m.conversation_id, count(*)::int as unread
    from messages m
    join conversation_members cm
      on cm.conversation_id = m.conversation_id and cm.user_id = ${userId}
    where m.sender_id <> ${userId}
      and m.deleted_at is null
      and (cm.last_read_at is null or m.server_timestamp > cm.last_read_at)
    group by m.conversation_id
  `);
  const unreadMap = new Map(unreadRows.map((r) => [r.conversation_id, Number(r.unread)]));

  const lastMessageRows = await rawRows<{
    conversation_id: string;
    id: string;
    sender_id: string;
    content_type: string;
    status: string;
    server_timestamp: string;
  }>(sql`
    select distinct on (m.conversation_id)
      m.conversation_id, m.id, m.sender_id, m.content_type, m.status, m.server_timestamp
    from messages m
    where m.conversation_id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    order by m.conversation_id, m.server_timestamp desc
  `);
  const lastMessageMap = new Map(lastMessageRows.map((r) => [r.conversation_id, r]));

  const keyRows = deviceId
    ? await rawRows<{ conversation_id: string; wrapped_key: string | null }>(sql`
        select c.id as conversation_id, ckw.wrapped_key
        from conversations c
        left join conversation_key_wraps ckw
          on ckw.conversation_id = c.id and ckw.recipient_device_id = ${deviceId}
        where c.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      `)
    : [];
  const keyMap = new Map(keyRows.map((r) => [r.conversation_id, Boolean(r.wrapped_key)]));

  const onlineThreshold = new Date(Date.now() - 90_000).toISOString();

  return convRows.map((conv) => {
    const members = memberRows
      .filter((m) => m.conversationId === conv.id)
      .map((m) => ({
        id: m.id,
        name: fullName(m),
        initials: initials(m),
        userType: m.userType,
        status: m.status,
        online: Boolean(m.lastActiveAt && new Date(m.lastActiveAt) > new Date(onlineThreshold)),
      }));
    const last = lastMessageMap.get(conv.id);
    const others = members.filter((m) => m.id !== userId);
    return {
      id: conv.id,
      type: conv.type,
      title:
        conv.title ??
        (conv.type === "direct"
          ? others.map((m) => m.name).join(", ") || "Saved channel"
          : "Group channel"),
      groupId: conv.groupId,
      status: conv.status,
      lastMessageAt: conv.lastMessageAt ? conv.lastMessageAt.toISOString() : null,
      unreadCount: unreadMap.get(conv.id) ?? 0,
      members,
      lastMessage: last
        ? {
            id: last.id,
            senderId: last.sender_id,
            contentType: last.content_type,
            status: last.status,
            serverTimestamp: last.server_timestamp,
          }
        : null,
      hasConversationKey: keyMap.get(conv.id) ?? false,
      pendingKeyDevices: 0,
    };
  });
}

export type MessageDto = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderDeviceId: string;
  clientMessageId: string;
  contentType: string;
  ciphertext: string;
  ciphertextIv: string;
  systemText: string | null;
  replyToId: string | null;
  status: string;
  serverTimestamp: string;
  editedAt: string | null;
  deletedAt: string | null;
  recipientCount: number;
  deliveredCount: number;
  readCount: number;
  attachment: {
    id: string;
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
    scanStatus: string;
  } | null;
};

export async function listMessages(
  conversationId: string,
  opts: { limit?: number; before?: Date | null; after?: Date | null } = {},
): Promise<MessageDto[]> {
  const limit = Math.min(opts.limit ?? 60, 200);

  const conditions = [eq(messages.conversationId, conversationId)];
  if (opts.before) conditions.push(lt(messages.serverTimestamp, opts.before));
  if (opts.after) conditions.push(gt(messages.serverTimestamp, opts.after));

  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      senderFirstName: users.firstName,
      senderLastName: users.lastName,
      senderPreferred: users.preferredName,
      senderDeviceId: messages.senderDeviceId,
      clientMessageId: messages.clientMessageId,
      contentType: messages.contentType,
      ciphertext: messages.ciphertext,
      ciphertextIv: messages.ciphertextIv,
      systemText: messages.systemText,
      replyToId: messages.replyToId,
      status: messages.status,
      serverTimestamp: messages.serverTimestamp,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(and(...conditions))
    .orderBy(opts.after ? asc(messages.serverTimestamp) : desc(messages.serverTimestamp))
    .limit(limit);

  const ordered = opts.after ? rows : rows.reverse();
  if (ordered.length === 0) return [];

  const ids = ordered.map((r) => r.id);

  const receiptRows = await db
    .select({
      messageId: messageRecipients.messageId,
      userId: messageRecipients.userId,
      deviceId: messageRecipients.deviceId,
      deliveredAt: messageRecipients.deliveredAt,
      readAt: messageRecipients.readAt,
    })
    .from(messageRecipients)
    .where(inArray(messageRecipients.messageId, ids));

  const attachmentRows = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      fileName: attachments.fileName,
      fileSizeBytes: attachments.fileSizeBytes,
      mimeType: attachments.mimeType,
      scanStatus: attachments.scanStatus,
    })
    .from(attachments)
    .where(inArray(attachments.messageId, ids));

  return ordered.map((row) => {
    const receipts = receiptRows.filter((r) => r.messageId === row.id);
    const attachment = attachmentRows.find((a) => a.messageId === row.id);
    return {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      senderName: fullName({
        firstName: row.senderFirstName,
        lastName: row.senderLastName,
        preferredName: row.senderPreferred,
      }),
      senderDeviceId: row.senderDeviceId,
      clientMessageId: row.clientMessageId,
      contentType: row.contentType,
      ciphertext: row.ciphertext,
      ciphertextIv: row.ciphertextIv,
      systemText: row.systemText,
      replyToId: row.replyToId,
      status: row.status,
      serverTimestamp: row.serverTimestamp.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      recipientCount: receipts.length,
      deliveredCount: receipts.filter((r) => r.deliveredAt).length,
      readCount: receipts.filter((r) => r.readAt).length,
      attachment: attachment
        ? {
            id: attachment.id,
            fileName: attachment.fileName,
            fileSizeBytes: attachment.fileSizeBytes,
            mimeType: attachment.mimeType,
            scanStatus: attachment.scanStatus,
          }
        : null,
    };
  });
}

export async function listTypingUsers(conversationId: string, excludeUserId: string) {
  const threshold = new Date(Date.now() - 6000);
  const rows = await db
    .select({
      userId: typingIndicators.userId,
      firstName: users.firstName,
      lastName: users.lastName,
      preferredName: users.preferredName,
    })
    .from(typingIndicators)
    .innerJoin(users, eq(users.id, typingIndicators.userId))
    .where(
      and(
        eq(typingIndicators.conversationId, conversationId),
        gt(typingIndicators.updatedAt, threshold),
        ne(typingIndicators.userId, excludeUserId),
      ),
    );
  return rows.map((r) => ({
    userId: r.userId,
    name: fullName({ firstName: r.firstName, lastName: r.lastName, preferredName: r.preferredName }),
  }));
}

/* ─────────────────────────── admin ─────────────────────────── */

export async function adminOverview() {
  const [userCounts, groupCounts, conversationCount, messageCount, reportCounts] = await Promise.all([
    rawRows<{ status: string; count: number }>(
      sql`select status, count(*)::int as count from users where deleted_at is null group by status`,
    ),
    rawRows<{ status: string; count: number }>(
      sql`select status, count(*)::int as count from groups where deleted_at is null group by status`,
    ),
    rawRows<{ count: number }>(sql`select count(*)::int as count from conversations where status = 'active'`),
    rawRows<{ count: number }>(sql`select count(*)::int as count from messages where deleted_at is null`),
    rawRows<{ status: string; count: number }>(
      sql`select status, count(*)::int as count from reports group by status`,
    ),
  ]);

  const [recentAudit, recentSecurity, messageTypes] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        eventType: auditLogs.eventType,
        action: auditLogs.action,
        actorId: auditLogs.actorId,
        actorName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        result: auditLogs.result,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(12),
    db
      .select({
        id: securityEvents.id,
        eventType: securityEvents.eventType,
        severity: securityEvents.severity,
        ipAddress: securityEvents.ipAddress,
        details: securityEvents.details,
        createdAt: securityEvents.createdAt,
      })
      .from(securityEvents)
      .orderBy(desc(securityEvents.createdAt))
      .limit(10),
    rawRows<{ content_type: string; count: number }>(
      sql`select content_type, count(*)::int as count from messages group by content_type`,
    ),
  ]);

  const byStatus = (rows: Array<{ status: string; count: number }>) =>
    rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = Number(row.count);
      return acc;
    }, {});

  return {
    users: byStatus(userCounts),
    groups: byStatus(groupCounts),
    reports: byStatus(reportCounts),
    conversations: Number(conversationCount[0]?.count ?? 0),
    messages: Number(messageCount[0]?.count ?? 0),
    messageTypes: messageTypes.map((m) => ({ contentType: m.content_type, count: Number(m.count) })),
    recentAudit: recentAudit.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      action: row.action,
      actorId: row.actorId,
      actorName: row.actorName,
      targetType: row.targetType,
      targetId: row.targetId,
      result: row.result,
      createdAt: row.createdAt.toISOString(),
    })),
    recentSecurity: recentSecurity.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      severity: row.severity,
      ipAddress: row.ipAddress,
      details: row.details,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  userType: string;
  status: string;
  department: string | null;
  gradeClass: string | null;
  program: string | null;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  createdByAdminId: string;
  roleNames: string[];
  deviceCount: number;
  lockedUntil: string | null;
};

export async function listAdminUsers(filters: {
  status?: string;
  userType?: string;
  search?: string;
  limit?: number;
}): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      preferredName: users.preferredName,
      userType: users.userType,
      status: users.status,
      department: users.department,
      gradeClass: users.gradeClass,
      program: users.program,
      mfaEnabled: users.mfaEnabled,
      mfaRequired: users.mfaRequired,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      createdByAdminId: users.createdByAdminId,
      lockedUntil: users.lockedUntil,
      roleNames: sql<string[]>`coalesce(array_agg(distinct ${roles.name}) filter (where ${roles.name} is not null), '{}')`,
      deviceCount: sql<number>`(select count(*)::int from devices d where d.user_id = ${users.id} and d.status = 'active')`,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        isNull(users.deletedAt),
        filters.status ? eq(users.status, filters.status) : undefined,
        filters.userType ? eq(users.userType, filters.userType) : undefined,
        filters.search && filters.search.trim().length > 0
          ? or(
              sql`${users.firstName} ilike ${`%${filters.search.trim()}%`}`,
              sql`${users.lastName} ilike ${`%${filters.search.trim()}%`}`,
              sql`${users.email} ilike ${`%${filters.search.trim()}%`}`,
            )
          : undefined,
      ),
    )
    .groupBy(users.id)
    .orderBy(asc(users.firstName))
    .limit(Math.min(filters.limit ?? 100, 300));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: fullName(row),
    userType: row.userType,
    status: row.status,
    department: row.department,
    gradeClass: row.gradeClass,
    program: row.program,
    mfaEnabled: row.mfaEnabled,
    mfaRequired: row.mfaRequired,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdByAdminId: row.createdByAdminId,
    roleNames: row.roleNames ?? [],
    deviceCount: Number(row.deviceCount ?? 0),
    lockedUntil: row.lockedUntil ? row.lockedUntil.toISOString() : null,
  }));
}

export async function listAdminGroups(search?: string) {
  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      groupType: groups.groupType,
      status: groups.status,
      visibility: groups.visibility,
      maxMembers: groups.maxMembers,
      announcementOnly: groups.announcementOnly,
      retentionPolicyDays: groups.retentionPolicyDays,
      fileSharingEnabled: groups.fileSharingEnabled,
      voiceVideoEnabled: groups.voiceVideoEnabled,
      videoCallsEnabled: groups.videoCallsEnabled,
      voiceCallsEnabled: groups.voiceCallsEnabled,
      callStartPermission: groups.callStartPermission,
      callJoinPermission: groups.callJoinPermission,
      screenSharingEnabled: groups.screenSharingEnabled,
      maxCallParticipants: groups.maxCallParticipants,
      createdAt: groups.createdAt,
      memberCount: sql<number>`(select count(*)::int from group_members gm where gm.group_id = ${groups.id} and gm.removed_at is null)`,
      conversationCount: sql<number>`(select count(*)::int from conversations c where c.group_id = ${groups.id} and c.status = 'active')`,
    })
    .from(groups)
    .where(
      and(
        isNull(groups.deletedAt),
        search && search.trim().length > 0
          ? sql`${groups.name} ilike ${`%${search.trim()}%`}`
          : undefined,
      ),
    )
    .orderBy(asc(groups.name))
    .limit(200);

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    memberCount: Number(row.memberCount ?? 0),
    conversationCount: Number(row.conversationCount ?? 0),
  }));
}

export async function listGroupMembers(groupId: string) {
  const rows = await db
    .select({
      userId: users.id,
      name: sql<string>`coalesce(nullif(${users.preferredName}, ''), ${users.firstName} || ' ' || ${users.lastName})`,
      email: users.email,
      userType: users.userType,
      status: users.status,
      memberRole: groupMembers.memberRole,
      joinedAt: groupMembers.joinedAt,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), isNull(groupMembers.removedAt)))
    .orderBy(asc(users.firstName));
  return rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
}

export async function myGroups(userId: string) {
  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      groupType: groups.groupType,
      status: groups.status,
      memberRole: groupMembers.memberRole,
      memberCount: sql<number>`(select count(*)::int from group_members gm where gm.group_id = ${groups.id} and gm.removed_at is null)`,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), isNull(groupMembers.removedAt), eq(groups.status, "active")))
    .orderBy(asc(groups.name));
  return rows.map((r) => ({ ...r, memberCount: Number(r.memberCount ?? 0) }));
}

export async function userPreferencesFor(userId: string) {
  const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(userPreferences).values({ userId }).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];
  // Another request created the row between our read and insert.
  const concurrent = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  if (!concurrent[0]) throw new Error("User preferences could not be initialized");
  return concurrent[0];
}

export async function listUserSessions(userId: string) {
  const rows = await db
    .select({
      id: sessions.id,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      isAdminSession: sessions.isAdminSession,
      mfaVerified: sessions.mfaVerified,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
      deviceId: sessions.deviceId,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.createdAt))
    .limit(25);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}

export async function listUserDevices(userId: string) {
  const rows = await db
    .select({
      id: devices.id,
      deviceName: devices.deviceName,
      browserInfo: devices.browserInfo,
      status: devices.status,
      lastActiveAt: devices.lastActiveAt,
      createdAt: devices.createdAt,
      ipAddress: devices.ipAddress,
    })
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(desc(devices.lastActiveAt));
  return rows.map((r) => ({
    ...r,
    lastActiveAt: r.lastActiveAt ? r.lastActiveAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listNotifications(userId: string, limit = 40) {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    data: r.data,
    status: r.status,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listAuditLogsPage(opts: { limit?: number; eventType?: string; actorId?: string }) {
  const rows = await db
    .select({
      id: auditLogs.id,
      eventType: auditLogs.eventType,
      action: auditLogs.action,
      actorId: auditLogs.actorId,
      actorName: sql<string>`coalesce(nullif(${users.preferredName}, ''), ${users.firstName} || ' ' || ${users.lastName})`,
      actorRole: auditLogs.actorRole,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      details: auditLogs.details,
      result: auditLogs.result,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(
      and(
        opts.eventType ? eq(auditLogs.eventType, opts.eventType) : undefined,
        opts.actorId ? eq(auditLogs.actorId, opts.actorId) : undefined,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(opts.limit ?? 100, 300));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function listSecurityEventsPage(opts: { limit?: number; severity?: string }) {
  const rows = await db
    .select({
      id: securityEvents.id,
      eventType: securityEvents.eventType,
      severity: securityEvents.severity,
      userId: securityEvents.userId,
      userName: sql<string | null>`coalesce(nullif(${users.preferredName}, ''), ${users.firstName} || ' ' || ${users.lastName})`,
      ipAddress: securityEvents.ipAddress,
      details: securityEvents.details,
      createdAt: securityEvents.createdAt,
    })
    .from(securityEvents)
    .leftJoin(users, eq(users.id, securityEvents.userId))
    .where(opts.severity ? eq(securityEvents.severity, opts.severity) : undefined)
    .orderBy(desc(securityEvents.createdAt))
    .limit(Math.min(opts.limit ?? 100, 300));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function listReports(status?: string) {
  const rows = await db
    .select({
      id: reports.id,
      reporterId: reports.reporterId,
      reporterName: sql<string>`coalesce(nullif(${users.preferredName}, ''), ${users.firstName} || ' ' || ${users.lastName})`,
      targetType: reports.targetType,
      targetId: reports.targetId,
      reason: reports.reason,
      description: reports.description,
      submittedContent: reports.submittedContent,
      status: reports.status,
      resolutionNotes: reports.resolutionNotes,
      createdAt: reports.createdAt,
      resolvedAt: reports.resolvedAt,
    })
    .from(reports)
    .leftJoin(users, eq(users.id, reports.reporterId))
    .where(status && status !== "all" ? eq(reports.status, status) : undefined)
    .orderBy(desc(reports.createdAt))
    .limit(100);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  }));
}

export async function listReportsForUser(userId: string) {
  const rows = await db
    .select({
      id: reports.id,
      reason: reports.reason,
      status: reports.status,
      resolutionNotes: reports.resolutionNotes,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(eq(reports.reporterId, userId))
    .orderBy(desc(reports.createdAt))
    .limit(100);
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listInvitations() {
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      firstName: invitations.firstName,
      lastName: invitations.lastName,
      userType: invitations.userType,
      roleId: invitations.roleId,
      roleName: roles.name,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      assignedGroups: invitations.assignedGroups,
    })
    .from(invitations)
    .leftJoin(roles, eq(roles.id, invitations.roleId))
    .orderBy(desc(invitations.createdAt))
    .limit(100);
  return rows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}

export async function listAllRoles() {
  return db
    .select({ id: roles.id, name: roles.name, description: roles.description, permissions: roles.permissions })
    .from(roles)
    .orderBy(asc(roles.name));
}

export async function getSettings() {
  const rows = await db.select().from(platformSettings).orderBy(asc(platformSettings.key));
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    description: r.description,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function adminUserDetail(userId: string) {
  const rows = await listAdminUsers({ search: undefined, limit: 300 });
  const user = rows.find((r) => r.id === userId);
  if (!user) return null;
  const [userGroupRows, roleRows, securityRows, auditRows, deviceRows, sessionRows, preference] =
    await Promise.all([
      db
        .select({ groupId: groups.id, name: groups.name, groupType: groups.groupType })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(eq(groupMembers.userId, userId), isNull(groupMembers.removedAt))),
      db
        .select({ id: roles.id, name: roles.name })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.userId, userId)),
      listSecurityEventsPage({ limit: 20 }).then((all) => all.filter((e) => e.userId === userId)),
      db
        .select({
          id: auditLogs.id,
          eventType: auditLogs.eventType,
          action: auditLogs.action,
          createdAt: auditLogs.createdAt,
          result: auditLogs.result,
        })
        .from(auditLogs)
        .where(and(or(eq(auditLogs.actorId, userId), eq(auditLogs.targetId, userId))))
        .orderBy(desc(auditLogs.createdAt))
        .limit(20),
      listUserDevices(userId),
      listUserSessions(userId),
      userPreferencesFor(userId),
    ]);

  return {
    user,
    groups: userGroupRows,
    roles: roleRows,
    securityEvents: securityRows,
    auditTrail: auditRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    devices: deviceRows,
    sessions: sessionRows,
    preferences: preference,
  };
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  const rows = await rawRows<{ count: number }>(
    sql`select count(*)::int as count from notifications where user_id = ${userId} and read_at is null`,
  );
  return Number(rows[0]?.count ?? 0);
}
