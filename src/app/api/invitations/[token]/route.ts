/**
 * GET/POST /api/invitations/:token — token-gated onboarding.
 *
 * This is not public registration: a single-use, administrator-issued token is
 * required, it expires, and the resulting account records the inviting admin in
 * users.created_by_admin_id (TRD §1.3).
 */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { groupMembers, invitations, userPreferences, userRoles, users } from "@/db/schema";
import { notifyUser, recordAudit, recordSecurityEvent } from "@/lib/audit";
import { createSession, setSessionCookie } from "@/lib/auth";
import { hashPassword, passwordIssues, sha256, uuid } from "@/lib/crypto";
import {
  ApiError,
  enforceRateLimit,
  jsonOk,
  readJson,
  route,
  str,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

async function loadInvitation(token: string) {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, sha256(token)))
    .limit(1);
  const invitation = rows[0];
  if (!invitation) throw new ApiError("INVITATION_INVALID", "This onboarding link is not valid.", 404);
  if (invitation.revokedAt || invitation.status === "revoked") {
    throw new ApiError("INVITATION_REVOKED", "This invitation was revoked by an administrator.", 410);
  }
  if (invitation.status === "accepted") {
    throw new ApiError("INVITATION_ALREADY_ACCEPTED", "This invitation has already been used.", 409);
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new ApiError("INVITATION_EXPIRED", "This invitation has expired. Request a new one.", 410);
  }
  return invitation;
}

export const GET = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const { token } = await ctx.params;
  enforceRateLimit(`invitation:peek:${meta.ip}`, 30, 60_000);
  const invitation = await loadInvitation(token);

  const inviter = await db
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, invitation.invitedByAdminId))
    .limit(1);

  if (!invitation.openedAt) {
    await db.update(invitations).set({ openedAt: new Date(), status: "opened" }).where(eq(invitations.id, invitation.id));
  }

  return jsonOk(
    {
      email: invitation.email,
      firstName: invitation.firstName,
      lastName: invitation.lastName,
      userType: invitation.userType,
      expiresAt: invitation.expiresAt.toISOString(),
      groups: invitation.assignedGroups,
      invitedBy: inviter[0] ? `${inviter[0].firstName} ${inviter[0].lastName}` : "an administrator",
      passwordPolicy: "Minimum 12 characters with upper, lower, number and symbol.",
    },
    meta,
  );
});

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const { token } = await ctx.params;
  enforceRateLimit(`invitation:accept:${meta.ip}`, 10, 15 * 60_000);
  const invitation = await loadInvitation(token);

  const body = await readJson(req);
  const password = str(body, "password", { required: true, max: 200, label: "Password" })!;
  const confirmPassword = str(body, "confirmPassword", { required: true, max: 200, label: "Password confirmation" })!;
  if (password !== confirmPassword) {
    throw new ApiError("VALIDATION_PASSWORD_MISMATCH", "The passwords do not match.", 422);
  }
  const issues = passwordIssues(password);
  if (issues.length > 0) throw new ApiError("VALIDATION_PASSWORD_WEAK", issues.join(" "), 422, { issues });

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)).limit(1);
  if (existing.length > 0) {
    throw new ApiError("USER_EMAIL_EXISTS", "An account already exists for this address.", 409);
  }

  const firstName = str(body, "firstName", { max: 80 }) ?? invitation.firstName;
  const lastName = str(body, "lastName", { max: 80 }) ?? invitation.lastName;
  const phoneNumber = str(body, "phoneNumber", { max: 32 });
  const userId = uuid();

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email: invitation.email,
      passwordHash: hashPassword(password),
      firstName,
      lastName,
      preferredName: firstName,
      phoneNumber: phoneNumber ?? null,
      userType: invitation.userType,
      status: "active",
      createdByAdminId: invitation.invitedByAdminId,
    });
    await tx.insert(userRoles).values({ userId, roleId: invitation.roleId, assignedBy: invitation.invitedByAdminId });
    await tx.insert(userPreferences).values({ userId }).onConflictDoNothing();
    const assignedGroups = Array.isArray(invitation.assignedGroups) ? (invitation.assignedGroups as string[]) : [];
    if (assignedGroups.length > 0) {
      await tx
        .insert(groupMembers)
        .values(assignedGroups.map((groupId) => ({ groupId, userId, addedBy: invitation.invitedByAdminId })))
        .onConflictDoNothing();
    }
    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(invitations.id, invitation.id));
  });

  const { token: sessionToken, expiresAt } = await createSession(userId, meta, { mfaVerified: true });
  await setSessionCookie(sessionToken, expiresAt);

  await notifyUser({
    userId: invitation.invitedByAdminId,
    type: "invitation",
    title: "Invitation accepted",
    body: `${firstName} ${lastName} completed onboarding and activated their account.`,
    data: { deepLink: "/app/admin?tab=users" },
  });
  await recordAudit({
    eventType: "invitation.accepted",
    actorId: userId,
    action: "create",
    targetType: "user",
    targetId: userId,
    details: { email: invitation.email, invitedBy: invitation.invitedByAdminId },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId,
    eventType: "account_activated_via_invitation",
    severity: "info",
    ipAddress: meta.ip,
    details: { invitationId: invitation.id },
  });

  return jsonOk({ userId, next: "/app" }, meta, 201);
});
