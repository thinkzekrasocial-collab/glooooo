/** GET/POST/DELETE /api/admin/groups/:id/members — roster management. */
import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { groupMembers, groups, users } from "@/db/schema";
import { notifyUser, recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { listGroupMembers } from "@/lib/data";
import {
  ApiError,
  enumValue,
  jsonOk,
  readJson,
  route,
  stringArray,
} from "@/lib/http";
import { PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function loadGroup(id: string) {
  const rows = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  const group = rows[0];
  if (!group || group.deletedAt) throw new ApiError("GROUP_NOT_FOUND", "Group not found.", 404);
  return group;
}

export const GET = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  await requirePermission(PERMISSIONS.groupsView);
  const { id } = await ctx.params;
  await loadGroup(id);
  return jsonOk({ members: await listGroupMembers(id) }, meta);
});

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.groupsManageMembers);
  const { id } = await ctx.params;
  const group = await loadGroup(id);

  const body = await readJson(req);
  const userIds = stringArray(body, "userIds", { required: true, maxItems: 300 })!;
  const memberRole = enumValue(body, "memberRole", ["admin", "moderator", "member"] as const) ?? "member";

  const activeUsers = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(and(isNull(users.deletedAt), eq(users.status, "active")));
  const allowed = new Set(activeUsers.map((u) => u.id));
  const invalid = userIds.filter((userId) => !allowed.has(userId));
  if (invalid.length > 0) {
    throw new ApiError("VALIDATION_USER_INVALID", "Some accounts are not active provisioned members.", 422, {
      invalid,
    });
  }

  await db
    .insert(groupMembers)
    .values(userIds.map((userId) => ({ groupId: id, userId, memberRole, addedBy: admin.id })))
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { memberRole, removedAt: null },
    });

  for (const userId of userIds) {
    await notifyUser({
      userId,
      type: "system",
      title: `Added to ${group.name}`,
      body: "An administrator updated your group membership.",
      data: { deepLink: "/app" },
    });
  }

  await recordAudit({
    eventType: "admin.group.members_added",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "create",
    targetType: "group",
    targetId: id,
    details: { added: userIds.length, memberRole },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, added: userIds.length, members: await listGroupMembers(id) }, meta, 201);
});

export const DELETE = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.groupsManageMembers);
  const { id } = await ctx.params;
  await loadGroup(id);

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  if (!userId) throw new ApiError("VALIDATION_REQUIRED", "userId query parameter is required.", 422);

  await db
    .update(groupMembers)
    .set({ removedAt: new Date() })
    .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, userId)));

  await recordAudit({
    eventType: "admin.group.member_removed",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "delete",
    targetType: "group",
    targetId: id,
    details: { removedUserId: userId },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, members: await listGroupMembers(id) }, meta);
});
