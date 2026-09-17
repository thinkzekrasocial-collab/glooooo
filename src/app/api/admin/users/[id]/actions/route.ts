/**
 * POST /api/admin/users/:id/actions — account lifecycle, role and group edits.
 * Every branch re-authenticates the caller's permission and appends an audit event.
 */
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { groupMembers, groups, roles, userRoles, users } from "@/db/schema";
import { notifyUser, recordAudit, recordSecurityEvent } from "@/lib/audit";
import { requirePermission, revokeAllSessions } from "@/lib/auth";
import { generateTemporaryPassword, hashPassword, passwordIssues } from "@/lib/crypto";
import {
  ApiError,
  enforceRateLimit,
  enumValue,
  intValue,
  jsonOk,
  readJson,
  route,
  str,
} from "@/lib/http";
import { PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const admin = await requirePermission(PERMISSIONS.usersUpdate);
  const { id } = await ctx.params;
  const body = await readJson(req);
  const action = enumValue(
    body,
    "action",
    [
      "activate",
      "suspend",
      "deactivate",
      "unlock",
      "reset_password",
      "require_mfa",
      "remove_mfa",
      "assign_role",
      "remove_role",
      "add_group",
      "remove_group",
      "revoke_sessions",
    ] as const,
    { required: true },
  )!;

  enforceRateLimit(`admin:user:action:${admin.id}`, 120, 60_000);

  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const target = rows[0];
  if (!target || target.deletedAt) throw new ApiError("USER_NOT_FOUND", "Account not found.", 404);

  const isSelf = target.id === admin.id;
  let response: Record<string, unknown> = { ok: true, action };

  switch (action) {
    case "activate": {
      await db
        .update(users)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(users.id, id));
      await notifyUser({
        userId: id,
        type: "system",
        title: "Account activated",
        body: "Your GlobeBridge account is active. You can now sign in.",
        data: { deepLink: "/login" },
      });
      response = { ...response, status: "active" };
      break;
    }
    case "suspend": {
      if (isSelf) throw new ApiError("USER_SELF_SUSPEND", "You cannot suspend your own account.", 409);
      await db
        .update(users)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(users.id, id));
      const revoked = await revokeAllSessions(id, "account_suspended");
      await notifyUser({
        userId: id,
        type: "security",
        title: "Account suspended",
        body: "An administrator suspended this account. Contact student services for a review.",
        data: { deepLink: "/login" },
      });
      await recordSecurityEvent({
        userId: id,
        eventType: "account_suspended",
        severity: "critical",
        ipAddress: meta.ip,
        details: { byAdmin: admin.id, sessionsRevoked: revoked },
      });
      response = { ...response, status: "suspended", sessionsRevoked: revoked };
      break;
    }
    case "deactivate": {
      if (isSelf) throw new ApiError("USER_SELF_DEACTIVATE", "You cannot deactivate your own account.", 409);
      await db
        .update(users)
        .set({ status: "deactivated", updatedAt: new Date() })
        .where(eq(users.id, id));
      await revokeAllSessions(id, "account_deactivated");
      response = { ...response, status: "deactivated" };
      break;
    }
    case "unlock": {
      await db
        .update(users)
        .set({ lockedUntil: null, failedLoginCount: 0, updatedAt: new Date() })
        .where(eq(users.id, id));
      response = { ...response, locked: false };
      break;
    }
    case "reset_password": {
      const supplied = str(body, "password", { max: 200 });
      const temporaryPassword = supplied ?? generateTemporaryPassword();
      const issues = passwordIssues(temporaryPassword);
      if (issues.length > 0) {
        throw new ApiError("VALIDATION_PASSWORD_WEAK", issues.join(" "), 422, { issues });
      }
      await db
        .update(users)
        .set({
          passwordHash: hashPassword(temporaryPassword),
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      const revoked = await revokeAllSessions(id, "admin_password_reset");
      await notifyUser({
        userId: id,
        type: "security",
        title: "Password reset by administrator",
        body: "Sign in with the temporary password issued by an administrator, then change it immediately.",
        data: { deepLink: "/login" },
      });
      await recordSecurityEvent({
        userId: id,
        eventType: "password_reset_by_admin",
        severity: "warning",
        ipAddress: meta.ip,
        details: { byAdmin: admin.id, sessionsRevoked: revoked },
      });
      response = {
        ...response,
        temporaryPassword: supplied ? undefined : temporaryPassword,
        sessionsRevoked: revoked,
      };
      break;
    }
    case "require_mfa": {
      await db.update(users).set({ mfaRequired: true, updatedAt: new Date() }).where(eq(users.id, id));
      await notifyUser({
        userId: id,
        type: "security",
        title: "Multi-factor authentication required",
        body: "Policy now requires TOTP verification on your account. Enrol from Settings → Security.",
        data: { deepLink: "/app/settings" },
      });
      response = { ...response, mfaRequired: true };
      break;
    }
    case "remove_mfa": {
      await requirePermission(PERMISSIONS.usersViewSecurity);
      await db
        .update(users)
        .set({ mfaRequired: false, mfaEnabled: false, mfaSecret: null, updatedAt: new Date() })
        .where(eq(users.id, id));
      await recordSecurityEvent({
        userId: id,
        eventType: "mfa_removed_by_admin",
        severity: "critical",
        ipAddress: meta.ip,
        details: { byAdmin: admin.id },
      });
      response = { ...response, mfaEnabled: false };
      break;
    }
    case "assign_role": {
      await requirePermission(PERMISSIONS.usersManageRoles);
      const roleId = str(body, "roleId", { required: true, max: 64 })!;
      const roleRow = await db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.id, roleId)).limit(1);
      if (roleRow.length === 0) throw new ApiError("ROLE_NOT_FOUND", "That role does not exist.", 404);
      await db.insert(userRoles).values({ userId: id, roleId, assignedBy: admin.id }).onConflictDoNothing();
      response = { ...response, roleId, role: roleRow[0].name };
      break;
    }
    case "remove_role": {
      await requirePermission(PERMISSIONS.usersManageRoles);
      const roleId = str(body, "roleId", { required: true, max: 64 })!;
      if (id === admin.id && roleId === "role-super-admin") {
        throw new ApiError("ROLE_SELF_REVOKE", "You cannot remove your own super admin role.", 409);
      }
      await db.delete(userRoles).where(and(eq(userRoles.userId, id), eq(userRoles.roleId, roleId)));
      response = { ...response, roleId };
      break;
    }
    case "add_group": {
      await requirePermission(PERMISSIONS.usersManageGroups);
      const groupId = str(body, "groupId", { required: true, max: 64 })!;
      const groupRow = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).limit(1);
      if (groupRow.length === 0) throw new ApiError("GROUP_NOT_FOUND", "Group not found.", 404);
      await db
        .insert(groupMembers)
        .values({ groupId, userId: id, addedBy: admin.id })
        .onConflictDoNothing();
      response = { ...response, groupId };
      break;
    }
    case "remove_group": {
      await requirePermission(PERMISSIONS.usersManageGroups);
      const groupId = str(body, "groupId", { required: true, max: 64 })!;
      await db
        .update(groupMembers)
        .set({ removedAt: new Date() })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, id)));
      response = { ...response, groupId };
      break;
    }
    case "revoke_sessions": {
      const revoked = await revokeAllSessions(id, "admin_forced_logout");
      response = { ...response, sessionsRevoked: revoked };
      break;
    }
    default:
      break;
  }

  const expired = intValue(body, "accountExpiresInDays", { min: 1, max: 3650 });
  if (expired !== undefined) {
    await db
      .update(users)
      .set({ accountExpiresAt: new Date(Date.now() + expired * 86_400_000) })
      .where(eq(users.id, id));
  }

  await recordAudit({
    eventType: `admin.user.${action}`,
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "update",
    targetType: "user",
    targetId: id,
    details: { action, email: target.email },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk(response, meta);
});
