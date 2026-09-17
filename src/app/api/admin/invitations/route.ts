/**
 * GET/POST/DELETE /api/admin/invitations — operator-issued onboarding tokens.
 *
 * Invitations are the ONLY way a non-admin can become part of the platform
 * besides direct admin creation. The raw token is returned exactly once; only
 * its SHA-256 hash is stored (TRD §1.3).
 */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invitations, roles, users } from "@/db/schema";
import { notifyUser, recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { randomToken, sha256, uuid } from "@/lib/crypto";
import { listInvitations } from "@/lib/data";
import {
  ApiError,
  enforceRateLimit,
  enumValue,
  intValue,
  isValidEmail,
  jsonOk,
  readJson,
  route,
  str,
  stringArray,
} from "@/lib/http";
import { PERMISSIONS, USER_TYPES, roleIdForUserType } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.invitationsManage);
  return jsonOk({ invitations: await listInvitations() }, meta);
});

export const POST = route(async (req: NextRequest, meta) => {
  const admin = await requirePermission(PERMISSIONS.invitationsManage);
  enforceRateLimit(`admin:invite:${admin.id}`, 40, 60_000);

  const body = await readJson(req);
  const email = str(body, "email", { required: true, max: 254, label: "Email" })!.toLowerCase();
  if (!isValidEmail(email)) throw new ApiError("VALIDATION_EMAIL", "Enter a valid email address.", 422);
  const firstName = str(body, "firstName", { required: true, max: 80, label: "First name" })!;
  const lastName = str(body, "lastName", { required: true, max: 80, label: "Last name" })!;
  const userType = enumValue(body, "userType", USER_TYPES, { required: true })!;
  const roleId = str(body, "roleId", { max: 64 }) ?? roleIdForUserType(userType);
  const groupIds = stringArray(body, "groupIds") ?? [];
  const expiresInDays = intValue(body, "expiresInDays", { min: 1, max: 30 }) ?? 7;

  const existingUser = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existingUser.length > 0) {
    throw new ApiError("USER_EMAIL_EXISTS", "An account already uses that email address.", 409);
  }
  const roleRow = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
  if (roleRow.length === 0) throw new ApiError("ROLE_NOT_FOUND", "That role does not exist.", 404);

  const pending = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(eq(invitations.email, email));
  for (const row of pending) {
    await db
      .update(invitations)
      .set({ status: "revoked", revokedAt: new Date(), revokedBy: admin.id })
      .where(eq(invitations.id, row.id));
  }

  const token = randomToken(32);
  const invitationId = uuid();
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);

  await db.insert(invitations).values({
    id: invitationId,
    email,
    firstName,
    lastName,
    userType,
    roleId,
    invitedByAdminId: admin.id,
    tokenHash: sha256(token),
    status: "sent",
    assignedGroups: groupIds,
    expiresAt,
    sentAt: new Date(),
  });

  await recordAudit({
    eventType: "admin.invitation.created",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "create",
    targetType: "invitation",
    targetId: invitationId,
    details: { email, userType, roleId, groups: groupIds.length, expiresAt: expiresAt.toISOString() },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await notifyUser({
    userId: admin.id,
    type: "invitation",
    title: `Invitation issued for ${firstName} ${lastName}`,
    body: "Deliver the one-time onboarding link out-of-band. It expires automatically.",
    data: { deepLink: "/app/admin?tab=invitations" },
  });

  return jsonOk(
    {
      invitationId,
      email,
      /** Returned once only — never persisted in raw form. */
      onboardingUrl: `/invite/${token}`,
      token,
      expiresAt: expiresAt.toISOString(),
    },
    meta,
    201,
  );
});

export const DELETE = route(async (req: NextRequest, meta) => {
  const admin = await requirePermission(PERMISSIONS.invitationsManage);
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiError("VALIDATION_REQUIRED", "id query parameter is required.", 422);

  const rows = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
  const invitation = rows[0];
  if (!invitation) throw new ApiError("INVITATION_NOT_FOUND", "Invitation not found.", 404);
  if (invitation.status === "accepted") {
    throw new ApiError("INVITATION_ALREADY_ACCEPTED", "This invitation was already accepted.", 409);
  }

  await db
    .update(invitations)
    .set({ status: "revoked", revokedAt: new Date(), revokedBy: admin.id })
    .where(eq(invitations.id, id));

  await recordAudit({
    eventType: "admin.invitation.revoked",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "delete",
    targetType: "invitation",
    targetId: id,
    details: { email: invitation.email },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, status: "revoked" }, meta);
});
