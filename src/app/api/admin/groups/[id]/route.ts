/** PATCH/DELETE/POST /api/admin/groups/:id — update, archive/restore, soft delete. */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { listAdminGroups, listGroupMembers } from "@/lib/data";
import {
  ApiError,
  boolValue,
  enumValue,
  intValue,
  jsonOk,
  readJson,
  route,
  str,
} from "@/lib/http";
import { GROUP_TYPES, PERMISSIONS } from "@/lib/rbac";

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
  const [rows, members] = await Promise.all([listAdminGroups(), listGroupMembers(id)]);
  const group = rows.find((g) => g.id === id);
  return jsonOk({ group, members }, meta);
});

export const PATCH = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.groupsUpdate);
  const { id } = await ctx.params;
  await loadGroup(id);

  const body = await readJson(req);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const fields: string[] = [];

  const name = str(body, "name", { min: 2, max: 120 });
  if (name !== undefined) {
    updates.name = name;
    fields.push("name");
  }
  const description = str(body, "description", { max: 1000 });
  if (description !== undefined) {
    updates.description = description;
    fields.push("description");
  }
  const groupType = enumValue(body, "groupType", GROUP_TYPES);
  if (groupType !== undefined) {
    updates.groupType = groupType;
    fields.push("groupType");
  }
  const status = enumValue(body, "status", ["draft", "active", "archived"] as const);
  if (status !== undefined) {
    updates.status = status;
    fields.push("status");
  }
  const visibility = enumValue(body, "visibility", ["private", "discoverable"] as const);
  if (visibility !== undefined) {
    updates.visibility = visibility;
    fields.push("visibility");
  }
  const maxMembers = intValue(body, "maxMembers", { min: 2, max: 5000 });
  if (maxMembers !== undefined) {
    updates.maxMembers = maxMembers;
    fields.push("maxMembers");
  }
  const retentionPolicyDays = intValue(body, "retentionPolicyDays", { min: 1, max: 3650 });
  if (retentionPolicyDays !== undefined) {
    updates.retentionPolicyDays = retentionPolicyDays;
    fields.push("retentionPolicyDays");
  }
  const fileSharingEnabled = boolValue(body, "fileSharingEnabled");
  if (fileSharingEnabled !== undefined) {
    updates.fileSharingEnabled = fileSharingEnabled;
    fields.push("fileSharingEnabled");
  }
  const voiceVideoEnabled = boolValue(body, "voiceVideoEnabled");
  if (voiceVideoEnabled !== undefined) {
    updates.voiceVideoEnabled = voiceVideoEnabled;
    fields.push("voiceVideoEnabled");
  }
  for (const [key, allowed] of [
    ["videoCallsEnabled", "boolean"], ["voiceCallsEnabled", "boolean"], ["screenSharingEnabled", "boolean"],
  ] as const) {
    const value = boolValue(body, key);
    if (value !== undefined) { updates[key] = value; fields.push(key); }
    void allowed;
  }
  const callStartPermission = enumValue(body, "callStartPermission", ["admin_only", "staff_and_admin", "group_members"] as const);
  if (callStartPermission !== undefined) { updates.callStartPermission = callStartPermission; fields.push("callStartPermission"); }
  const callJoinPermission = enumValue(body, "callJoinPermission", ["group_members", "invited_members", "admins_and_members"] as const);
  if (callJoinPermission !== undefined) { updates.callJoinPermission = callJoinPermission; fields.push("callJoinPermission"); }
  const maxCallParticipants = intValue(body, "maxCallParticipants", { min: 2, max: 5000 });
  if (maxCallParticipants !== undefined) { updates.maxCallParticipants = maxCallParticipants; fields.push("maxCallParticipants"); }
  const announcementOnly = boolValue(body, "announcementOnly");
  if (announcementOnly !== undefined) {
    updates.announcementOnly = announcementOnly;
    fields.push("announcementOnly");
  }

  if (fields.length === 0) throw new ApiError("VALIDATION_NO_CHANGES", "No editable fields were provided.", 422);

  await db.update(groups).set(updates).where(eq(groups.id, id));
  await recordAudit({
    eventType: "admin.group.updated",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "update",
    targetType: "group",
    targetId: id,
    details: { fields },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, fields }, meta);
});

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.groupsUpdate);
  const { id } = await ctx.params;
  await loadGroup(id);

  const body = await readJson(req);
  const action = enumValue(body, "action", ["archive", "restore"] as const, { required: true })!;
  const archived = action === "archive";
  await db
    .update(groups)
    .set({
      status: archived ? "archived" : "active",
      archivedAt: archived ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(groups.id, id));

  await recordAudit({
    eventType: archived ? "admin.group.archived" : "admin.group.restored",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "update",
    targetType: "group",
    targetId: id,
    details: { action },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, status: archived ? "archived" : "active" }, meta);
});

export const DELETE = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.groupsDelete);
  const { id } = await ctx.params;
  await loadGroup(id);

  await db
    .update(groups)
    .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(groups.id, id));

  await recordAudit({
    eventType: "admin.group.deleted",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "delete",
    targetType: "group",
    targetId: id,
    details: {},
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, softDeleted: true }, meta);
});
