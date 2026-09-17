/** GET/POST /api/admin/groups — group provisioning (TRD §10). */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { groupMembers, groups, users } from "@/db/schema";
import { notifyUser, recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { uuid } from "@/lib/crypto";
import { listAdminGroups } from "@/lib/data";
import {
  ApiError,
  boolValue,
  enforceRateLimit,
  enumValue,
  intValue,
  jsonOk,
  readJson,
  route,
  str,
  stringArray,
} from "@/lib/http";
import { GROUP_TYPES, PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.groupsView);
  const url = new URL(req.url);
  const rows = await listAdminGroups(url.searchParams.get("q") ?? undefined);
  return jsonOk({ groups: rows }, meta);
});

export const POST = route(async (req: NextRequest, meta) => {
  const admin = await requirePermission(PERMISSIONS.groupsCreate);
  enforceRateLimit(`admin:group:create:${admin.id}`, 30, 60_000);

  const body = await readJson(req);
  const name = str(body, "name", { required: true, min: 2, max: 120, label: "Group name" })!;
  const description = str(body, "description", { max: 1000 });
  const groupType = enumValue(body, "groupType", GROUP_TYPES, { required: true })!;
  const status = enumValue(body, "status", ["draft", "active"] as const) ?? "draft";
  const visibility = enumValue(body, "visibility", ["private", "discoverable"] as const) ?? "private";
  const maxMembers = intValue(body, "maxMembers", { min: 2, max: 5000 });
  const retentionPolicyDays = intValue(body, "retentionPolicyDays", { min: 1, max: 3650 });
  const fileSharingEnabled = boolValue(body, "fileSharingEnabled") ?? true;
  const voiceVideoEnabled = boolValue(body, "voiceVideoEnabled") ?? false;
  const videoCallsEnabled = boolValue(body, "videoCallsEnabled") ?? voiceVideoEnabled;
  const voiceCallsEnabled = boolValue(body, "voiceCallsEnabled") ?? voiceVideoEnabled;
  const screenSharingEnabled = boolValue(body, "screenSharingEnabled") ?? false;
  const callStartPermission = enumValue(body, "callStartPermission", ["admin_only", "staff_and_admin", "group_members"] as const) ?? "admin_only";
  const callJoinPermission = enumValue(body, "callJoinPermission", ["group_members", "invited_members", "admins_and_members"] as const) ?? "group_members";
  const maxCallParticipants = intValue(body, "maxCallParticipants", { min: 2, max: 5000 });
  const announcementOnly = boolValue(body, "announcementOnly") ?? false;
  const memberIds = stringArray(body, "memberIds") ?? [];

  const groupId = uuid();
  await db.insert(groups).values({
    id: groupId,
    name,
    description: description ?? null,
    groupType,
    status,
    visibility,
    maxMembers: maxMembers ?? null,
    retentionPolicyDays: retentionPolicyDays ?? null,
    fileSharingEnabled,
    voiceVideoEnabled,
    videoCallsEnabled,
    voiceCallsEnabled,
    screenSharingEnabled,
    callStartPermission,
    callJoinPermission,
    maxCallParticipants: maxCallParticipants ?? null,
    announcementOnly,
    createdByAdminId: admin.id,
  });

  if (memberIds.length > 0) {
    const validUsers = await db.select({ id: users.id, status: users.status }).from(users);
    const validIds = new Set(validUsers.filter((u) => u.status === "active").map((u) => u.id));
    const insertIds = memberIds.filter((id) => validIds.has(id));
    if (insertIds.length > 0) {
      await db
        .insert(groupMembers)
        .values(insertIds.map((userId) => ({ groupId, userId, addedBy: admin.id })))
        .onConflictDoNothing();
      for (const userId of insertIds) {
        await notifyUser({
          userId,
          type: "system",
          title: `Added to ${name}`,
          body: "An administrator added you to a group. Group channels are end-to-end encrypted.",
          data: { deepLink: "/app" },
        });
      }
    }
  }

  await recordAudit({
    eventType: "admin.group.created",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "create",
    targetType: "group",
    targetId: groupId,
    details: { name, groupType, status, members: memberIds.length },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  const created = await listAdminGroups(name);
  const group = created.find((g) => g.id === groupId);
  if (!group) throw new ApiError("GROUP_CREATE_FAILED", "Group could not be created.", 500);
  return jsonOk({ group }, meta, 201);
});
