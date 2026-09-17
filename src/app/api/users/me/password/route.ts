/** POST /api/users/me/password — change own password, then revoke other sessions. */
import { NextRequest } from "next/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { notifyUser, recordAudit, recordSecurityEvent } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { hashPassword, passwordIssues, verifyPassword } from "@/lib/crypto";
import { ApiError, enforceRateLimit, jsonOk, readJson, route, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  enforceRateLimit(`password:${session.id}`, 5, 15 * 60_000);

  const body = await readJson(req);
  const currentPassword = str(body, "currentPassword", { required: true, max: 200 });
  const newPassword = str(body, "newPassword", { required: true, max: 200 });
  const confirmPassword = str(body, "confirmPassword", { required: true, max: 200 });
  if (newPassword !== confirmPassword) {
    throw new ApiError("VALIDATION_PASSWORD_MISMATCH", "The new passwords do not match.", 422);
  }
  const issues = passwordIssues(newPassword!);
  if (issues.length > 0) {
    throw new ApiError("VALIDATION_PASSWORD_WEAK", issues.join(" "), 422, { issues });
  }

  const rows = await db.select().from(users).where(eq(users.id, session.id)).limit(1);
  const user = rows[0];
  if (!user) throw new ApiError("USER_NOT_FOUND", "Account not found.", 404);
  if (!verifyPassword(currentPassword!, user.passwordHash)) {
    await recordSecurityEvent({
      userId: user.id,
      eventType: "password_change_failure",
      severity: "warning",
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new ApiError("AUTH_INVALID_CREDENTIALS", "Your current password is incorrect.", 401);
  }
  if (verifyPassword(newPassword!, user.passwordHash)) {
    throw new ApiError("VALIDATION_PASSWORD_REUSED", "Choose a password you have not used before.", 422);
  }

  await db
    .update(users)
    .set({ passwordHash: hashPassword(newPassword!), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: "password_changed" })
    .where(and(eq(sessions.userId, user.id), ne(sessions.id, session.sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  await recordAudit({
    eventType: "user.password.changed",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "update",
    targetType: "user",
    targetId: session.id,
    details: { otherSessionsRevoked: revoked.length },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId: session.id,
    eventType: "password_changed",
    severity: "info",
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  await notifyUser({
    userId: session.id,
    type: "security",
    title: "Password changed",
    body: "Your password was updated. All other sessions were signed out.",
    data: { deepLink: "/app/settings" },
  });

  return jsonOk({ ok: true, revokedSessions: revoked.length }, meta);
});
