/** GET/PATCH/DELETE /api/admin/users/:id — admin account management. */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { notifyUser, recordAudit, recordSecurityEvent } from "@/lib/audit";
import { requirePermission, revokeAllSessions } from "@/lib/auth";
import { adminUserDetail } from "@/lib/data";
import {
  ApiError,
  boolValue,
  enumValue,
  jsonOk,
  readJson,
  route,
  str,
} from "@/lib/http";
import { PERMISSIONS, USER_TYPES } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  await requirePermission(PERMISSIONS.usersView);
  const { id } = await ctx.params;
  const detail = await adminUserDetail(id);
  if (!detail) throw new ApiError("USER_NOT_FOUND", "Account not found.", 404);
  return jsonOk(detail, meta);
});

export const PATCH = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.usersUpdate);
  const { id } = await ctx.params;
  const body = await readJson(req);

  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const target = rows[0];
  if (!target || target.deletedAt) throw new ApiError("USER_NOT_FOUND", "Account not found.", 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const fields: string[] = [];

  const firstName = str(body, "firstName", { max: 80 });
  if (firstName !== undefined) {
    updates.firstName = firstName;
    fields.push("firstName");
  }
  const lastName = str(body, "lastName", { max: 80 });
  if (lastName !== undefined) {
    updates.lastName = lastName;
    fields.push("lastName");
  }
  const preferredName = str(body, "preferredName", { max: 80 });
  if (preferredName !== undefined) {
    updates.preferredName = preferredName;
    fields.push("preferredName");
  }
  const phoneNumber = str(body, "phoneNumber", { max: 32 });
  if (phoneNumber !== undefined) {
    updates.phoneNumber = phoneNumber;
    fields.push("phoneNumber");
  }
  const department = str(body, "department", { max: 120 });
  if (department !== undefined) {
    updates.department = department;
    fields.push("department");
  }
  const gradeClass = str(body, "gradeClass", { max: 60 });
  if (gradeClass !== undefined) {
    updates.gradeClass = gradeClass;
    fields.push("gradeClass");
  }
  const program = str(body, "program", { max: 120 });
  if (program !== undefined) {
    updates.program = program;
    fields.push("program");
  }
  const campusLocation = str(body, "campusLocation", { max: 120 });
  if (campusLocation !== undefined) {
    updates.campusLocation = campusLocation;
    fields.push("campusLocation");
  }
  const studentId = str(body, "studentId", { max: 60 });
  if (studentId !== undefined) {
    updates.studentId = studentId;
    fields.push("studentId");
  }
  const employeeId = str(body, "employeeId", { max: 60 });
  if (employeeId !== undefined) {
    updates.employeeId = employeeId;
    fields.push("employeeId");
  }
  const notes = str(body, "notes", { max: 2000 });
  if (notes !== undefined) {
    updates.notes = notes;
    fields.push("notes");
  }
  const userType = enumValue(body, "userType", USER_TYPES);
  if (userType !== undefined) {
    updates.userType = userType;
    fields.push("userType");
  }
  const mfaRequired = boolValue(body, "mfaRequired");
  if (mfaRequired !== undefined) {
    updates.mfaRequired = mfaRequired;
    fields.push("mfaRequired");
  }
  const accountExpiresAt = str(body, "accountExpiresAt", { max: 40 });
  if (accountExpiresAt !== undefined) {
    updates.accountExpiresAt = accountExpiresAt ? new Date(accountExpiresAt) : null;
    fields.push("accountExpiresAt");
  }
  if (body.messagingPerms !== undefined) {
    updates.messagingPerms = body.messagingPerms;
    fields.push("messagingPerms");
  }

  if (fields.length === 0) throw new ApiError("VALIDATION_NO_CHANGES", "No editable fields were provided.", 422);

  await db.update(users).set(updates).where(eq(users.id, id));

  await recordAudit({
    eventType: "admin.user.updated",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "update",
    targetType: "user",
    targetId: id,
    details: { fields },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await notifyUser({
    userId: id,
    type: "system",
    title: "Your profile was updated by an administrator",
    body: `Changed fields: ${fields.join(", ")}.`,
    data: { deepLink: "/app/settings" },
  });

  return jsonOk({ ok: true, fields }, meta);
});

export const DELETE = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.usersDelete);
  const { id } = await ctx.params;
  if (id === admin.id) throw new ApiError("USER_SELF_DELETE", "You cannot delete your own account.", 409);

  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const target = rows[0];
  if (!target) throw new ApiError("USER_NOT_FOUND", "Account not found.", 404);

  await db
    .update(users)
    .set({
      status: "deleted",
      deletedAt: new Date(),
      email: `deleted+${id}@globebridge.invalid`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));
  await revokeAllSessions(id, "account_soft_deleted");

  await recordAudit({
    eventType: "admin.user.deleted",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "delete",
    targetType: "user",
    targetId: id,
    details: { email: target.email },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId: admin.id,
    eventType: "admin_deleted_account",
    severity: "warning",
    ipAddress: meta.ip,
    details: { deletedUserId: id },
  });

  return jsonOk({ ok: true, softDeleted: true }, meta);
});
