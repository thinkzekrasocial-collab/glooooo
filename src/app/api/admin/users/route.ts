/**
 * GET  /api/admin/users  — paginated directory of provisioned accounts.
 * POST /api/admin/users  — THE ONLY account-creation path in the platform.
 *
 * createUser() requires an authenticated admin context: `createdByAdminId` is a
 * NOT NULL column, so a user row physically cannot exist without an admin
 * reference (TRD §1.3 layers 2 and 3).
 */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { groupMembers, roles, userPreferences, userRoles, users } from "@/db/schema";
import { notifyUser, recordAudit, recordSecurityEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { generateTemporaryPassword, hashPassword, passwordIssues, uuid } from "@/lib/crypto";
import { listAdminUsers } from "@/lib/data";
import {
  ApiError,
  boolValue,
  enforceRateLimit,
  enumValue,
  isValidEmail,
  jsonOk,
  readJson,
  route,
  str,
  stringArray,
} from "@/lib/http";
import { PERMISSIONS, USER_TYPES, roleIdForUserType } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.usersView);
  const url = new URL(req.url);
  const rows = await listAdminUsers({
    status: url.searchParams.get("status") ?? undefined,
    userType: url.searchParams.get("userType") ?? undefined,
    search: url.searchParams.get("q") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
  });
  return jsonOk({ users: rows, total: rows.length }, meta);
});

export const POST = route(async (req: NextRequest, meta) => {
  const admin = await requirePermission(PERMISSIONS.usersCreate);
  enforceRateLimit(`admin:user:create:${admin.id}`, 40, 60_000);

  const body = await readJson(req);
  const email = str(body, "email", { required: true, max: 254, label: "Email" })!.toLowerCase();
  if (!isValidEmail(email)) throw new ApiError("VALIDATION_EMAIL", "Enter a valid email address.", 422);

  const firstName = str(body, "firstName", { required: true, max: 80, label: "First name" })!;
  const lastName = str(body, "lastName", { required: true, max: 80, label: "Last name" })!;
  const userType = enumValue(body, "userType", USER_TYPES, { required: true })!;
  const status = enumValue(body, "status", ["pending", "active"] as const) ?? "pending";
  const department = str(body, "department", { max: 120 });
  const gradeClass = str(body, "gradeClass", { max: 60 });
  const program = str(body, "program", { max: 120 });
  const campusLocation = str(body, "campusLocation", { max: 120 });
  const studentId = str(body, "studentId", { max: 60 });
  const employeeId = str(body, "employeeId", { max: 60 });
  const phoneNumber = str(body, "phoneNumber", { max: 32 });
  const notes = str(body, "notes", { max: 2000 });
  const mfaRequired = boolValue(body, "mfaRequired") ?? (userType === "admin");
  const groupIds = stringArray(body, "groupIds") ?? [];
  const roleIdInput = str(body, "roleId", { max: 64 });
  const suppliedPassword = str(body, "password", { max: 200 });

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    throw new ApiError("USER_EMAIL_EXISTS", "An account already uses that email address.", 409);
  }

  const temporaryPassword = suppliedPassword ?? generateTemporaryPassword();
  const issues = passwordIssues(temporaryPassword);
  if (issues.length > 0) {
    throw new ApiError("VALIDATION_PASSWORD_WEAK", issues.join(" "), 422, { issues });
  }

  const roleId = roleIdInput ?? roleIdForUserType(userType);
  const roleRow = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
  if (roleRow.length === 0) throw new ApiError("ROLE_NOT_FOUND", "That role does not exist.", 404);

  const userId = uuid();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email,
      passwordHash: hashPassword(temporaryPassword),
      firstName,
      lastName,
      preferredName: firstName,
      phoneNumber: phoneNumber ?? null,
      userType,
      status,
      department: department ?? null,
      gradeClass: gradeClass ?? null,
      program: program ?? null,
      campusLocation: campusLocation ?? null,
      studentId: studentId ?? null,
      employeeId: employeeId ?? null,
      notes: notes ?? null,
      mfaRequired,
      createdByAdminId: admin.id,
    });
    await tx.insert(userRoles).values({ userId, roleId, assignedBy: admin.id });
    await tx.insert(userPreferences).values({ userId }).onConflictDoNothing();
    if (groupIds.length > 0) {
      await tx
        .insert(groupMembers)
        .values(groupIds.map((groupId) => ({ groupId, userId, addedBy: admin.id })))
        .onConflictDoNothing();
    }
  });

  await notifyUser({
    userId,
    type: "system",
    title: "Account provisioned",
    body: "An administrator created your GlobeBridge account. Sign in with the temporary password and change it immediately.",
    data: { deepLink: "/login" },
  });

  await recordAudit({
    eventType: "admin.user.created",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "create",
    targetType: "user",
    targetId: userId,
    details: { email, userType, roleId, status, mfaRequired, groups: groupIds.length },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId: admin.id,
    eventType: "admin_created_account",
    severity: "info",
    ipAddress: meta.ip,
    details: { createdUserId: userId, email },
  });

  return jsonOk(
    {
      user: { id: userId, email, firstName, lastName, userType, status, roleId, mfaRequired },
      temporaryPassword: suppliedPassword ? undefined : temporaryPassword,
      mustChangePassword: !suppliedPassword,
    },
    meta,
    201,
  );
});
