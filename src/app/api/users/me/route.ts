/** GET/PATCH /api/users/me — self-service profile (limited writable fields). */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { fullName, listUserDevices, myGroups, unreadNotificationCount, userPreferencesFor } from "@/lib/data";
import { ApiError, jsonOk, readJson, route, str } from "@/lib/http";

export const dynamic = "force-dynamic";

const WRITABLE_FIELDS = ["preferredName", "phoneNumber", "campusLocation", "dateOfBirth", "emergencyContact"] as const;
const RESTRICTED_FIELDS = ["email", "status", "userType", "studentId", "employeeId", "createdByAdminId", "department", "gradeClass", "program"];

export const GET = route(async (_req: NextRequest, meta) => {
  const session = await requireUser();
  const rows = await db.select().from(users).where(eq(users.id, session.id)).limit(1);
  const user = rows[0];
  if (!user) throw new ApiError("USER_NOT_FOUND", "Account not found.", 404);

  const [preferences, groups, devices, unread] = await Promise.all([
    userPreferencesFor(user.id),
    myGroups(user.id),
    listUserDevices(user.id),
    unreadNotificationCount(user.id),
  ]);

  return jsonOk(
    {
      user: {
        id: user.id,
        email: user.email,
        name: fullName(user),
        firstName: user.firstName,
        lastName: user.lastName,
        preferredName: user.preferredName,
        phoneNumber: user.phoneNumber,
        userType: user.userType,
        status: user.status,
        department: user.department,
        gradeClass: user.gradeClass,
        program: user.program,
        campusLocation: user.campusLocation,
        studentId: user.studentId,
        employeeId: user.employeeId,
        mfaEnabled: user.mfaEnabled,
        mfaRequired: user.mfaRequired,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      },
      preferences,
      groups,
      devices,
      unreadNotifications: unread,
      roles: session.roles,
      permissions: session.permissions,
    },
    meta,
  );
});

export const PATCH = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  const body = await readJson(req);

  for (const field of RESTRICTED_FIELDS) {
    if (field in body) {
      throw new ApiError(
        "VALIDATION_FORBIDDEN_FIELD",
        `${field} cannot be changed from self-service. Ask an administrator.`,
        422,
      );
    }
  }
  if (Object.keys(body).some((key) => !WRITABLE_FIELDS.includes(key as (typeof WRITABLE_FIELDS)[number]))) {
    throw new ApiError("VALIDATION_UNKNOWN_FIELD", "One or more fields are not editable.", 422, {
      writable: WRITABLE_FIELDS,
    });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const preferredName = str(body, "preferredName", { max: 80 });
  if (preferredName !== undefined) updates.preferredName = preferredName;
  const phoneNumber = str(body, "phoneNumber", { max: 32 });
  if (phoneNumber !== undefined) updates.phoneNumber = phoneNumber;
  const campusLocation = str(body, "campusLocation", { max: 120 });
  if (campusLocation !== undefined) updates.campusLocation = campusLocation;
  const dateOfBirth = str(body, "dateOfBirth", { max: 32 });
  if (dateOfBirth !== undefined) updates.dateOfBirth = dateOfBirth;
  if (body.emergencyContact !== undefined) {
    if (typeof body.emergencyContact !== "object" || body.emergencyContact === null || Array.isArray(body.emergencyContact)) {
      throw new ApiError("VALIDATION_TYPE", "emergencyContact must be an object.", 422);
    }
    const emergency = body.emergencyContact as Record<string, unknown>;
    if (Object.keys(emergency).length > 8 || Object.values(emergency).some((value) => typeof value !== "string" || value.length > 160)) {
      throw new ApiError("VALIDATION_RANGE", "emergencyContact contains invalid fields.", 422);
    }
    updates.emergencyContact = emergency;
  }

  const updated = await db.update(users).set(updates).where(eq(users.id, session.id)).returning();
  const user = updated[0];

  await recordAudit({
    eventType: "profile.updated",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "update",
    targetType: "user",
    targetId: session.id,
    details: { fields: Object.keys(updates).filter((k) => k !== "updatedAt") },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ user: { id: user.id, preferredName: user.preferredName, phoneNumber: user.phoneNumber } }, meta);
});
