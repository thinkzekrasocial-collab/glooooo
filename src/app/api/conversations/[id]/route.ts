/** GET /api/conversations/:id — channel detail: members, presence, typing, key state. */
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversationKeyWraps, conversations, groups, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { fullName, isConversationMember, listTypingUsers, rawRows } from "@/lib/data";
import { ApiError, jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;

  const rows = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  const conversation = rows[0];
  if (!conversation) throw new ApiError("CONVERSATION_NOT_FOUND", "Conversation not found.", 404);

  const member = await isConversationMember(session.id, id);
  if (!member) {
    throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
  }

  const memberRows = await db
    .select({
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      preferredName: users.preferredName,
      userType: users.userType,
      status: users.status,
      role: sql<string>`(select role from conversation_members cm where cm.conversation_id = ${id} and cm.user_id = ${users.id})`,
      lastReadAt: sql<string | null>`(select last_read_at from conversation_members cm where cm.conversation_id = ${id} and cm.user_id = ${users.id})`,
      online: sql<boolean>`exists (select 1 from devices d where d.user_id = ${users.id} and d.status = 'active' and d.last_active_at > now() - interval '90 seconds')`,
      deviceCount: sql<number>`(select count(*)::int from devices d where d.user_id = ${users.id} and d.status = 'active')`,
    })
    .from(users)
    .where(
      sql`exists (
        select 1 from conversation_members cm
        where cm.conversation_id = ${id} and cm.user_id = ${users.id} and cm.left_at is null
      )`,
    )
    .orderBy(users.firstName);

  const groupRows = conversation.groupId
    ? await db.select().from(groups).where(eq(groups.id, conversation.groupId)).limit(1)
    : [];

  const keyRows = session.deviceId
    ? await db
        .select({ wrappedKey: conversationKeyWraps.wrappedKey })
        .from(conversationKeyWraps)
        .where(
          and(
            eq(conversationKeyWraps.conversationId, id),
            eq(conversationKeyWraps.recipientDeviceId, session.deviceId),
          ),
        )
        .limit(1)
    : [];

  const missingKeyRows = session.deviceId
    ? await rawRows<{ device_id: string; user_id: string }>(sql`
        select d.id as device_id, d.user_id
        from devices d
        where d.status = 'active'
          and d.id <> ${session.deviceId}
          and exists (
            select 1 from conversation_members cm
            where cm.conversation_id = ${id} and cm.user_id = d.user_id and cm.left_at is null
          )
          and not exists (
            select 1 from conversation_key_wraps k
            where k.conversation_id = ${id} and k.recipient_device_id = d.id
          )
      `)
    : [];

  const myMembership = await db.execute(sql`
    select last_read_at, muted_until, archived, role
    from conversation_members
    where conversation_id = ${id} and user_id = ${session.id}
    limit 1
  `);
  const membership = (myMembership.rows[0] ?? {}) as Record<string, unknown>;

  const typing = await listTypingUsers(id, session.id);

  const group = groupRows[0];

  return jsonOk(
    {
      conversation: {
        id: conversation.id,
        type: conversation.type,
        title:
          conversation.title ??
          (conversation.type === "direct"
            ? memberRows
                .filter((m) => m.userId !== session.id)
                .map((m) => fullName(m))
                .join(", ")
            : "Group channel"),
        groupId: conversation.groupId,
        status: conversation.status,
        createdAt: conversation.createdAt.toISOString(),
        policy: group
          ? {
              announcementOnly: group.announcementOnly,
              fileSharingEnabled: group.fileSharingEnabled,
              retentionPolicyDays: group.retentionPolicyDays,
              visibility: group.visibility,
            }
          : {
              announcementOnly: false,
              fileSharingEnabled: true,
              retentionPolicyDays: null,
              visibility: "private",
            },
      },
      membership: {
        role: (membership.role as string) ?? "participant",
        lastReadAt: (membership.last_read_at as string | null) ?? null,
        mutedUntil: (membership.muted_until as string | null) ?? null,
        archived: Boolean(membership.archived),
      },
      members: memberRows.map((row) => ({
        userId: row.userId,
        name: fullName(row),
        userType: row.userType,
        status: row.status,
        role: row.role ?? "participant",
        lastReadAt: row.lastReadAt,
        online: Boolean(row.online),
        deviceCount: Number(row.deviceCount ?? 0),
      })),
      typing,
      encryption: {
        hasKeyForMyDevice: keyRows.length > 0,
        myDeviceId: session.deviceId,
        pendingKeyDevices: missingKeyRows.map((r) => ({ deviceId: r.device_id, userId: r.user_id })),
      },
    },
    meta,
  );
});
