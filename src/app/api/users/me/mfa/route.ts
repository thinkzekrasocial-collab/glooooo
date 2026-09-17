/** POST /api/users/me/mfa — enrol, confirm or disable TOTP MFA on own account. */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { notifyUser, recordAudit, recordSecurityEvent } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  otpauthUrl,
  verifyPassword,
  verifyTotp,
} from "@/lib/crypto";
import { ApiError, enforceRateLimit, enumValue, jsonOk, readJson, route, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  enforceRateLimit(`mfa-enroll:${session.id}`, 10, 10 * 60_000);

  const body = await readJson(req);
  const action = enumValue(body, "action", ["enroll", "verify", "disable"] as const, { required: true })!;
  const rows = await db.select().from(users).where(eq(users.id, session.id)).limit(1);
  const user = rows[0];
  if (!user) throw new ApiError("USER_NOT_FOUND", "Account not found.", 404);

  if (action === "enroll") {
    if (user.mfaEnabled) throw new ApiError("MFA_ALREADY_ENABLED", "MFA is already enabled.", 409);
    const secret = generateTotpSecret();
    await db
      .update(users)
      .set({ mfaSecret: encryptSecret(secret), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await recordAudit({
      eventType: "user.mfa.enroll_started",
      actorId: user.id,
      action: "create",
      targetType: "user",
      targetId: user.id,
      ipAddress: meta.ip,
      correlationId: meta.requestId,
    });
    return jsonOk(
      {
        secret,
        otpauthUrl: otpauthUrl(secret, user.email),
        qrHint: "Scan with any TOTP app, then confirm the 6-digit code.",
      },
      meta,
    );
  }

  if (action === "verify") {
    const code = str(body, "code", { required: true, min: 6, max: 6, label: "Verification code" })!;
    if (!user.mfaSecret) throw new ApiError("MFA_NOT_STARTED", "Start enrolment first.", 409);
    const secret = decryptSecret(user.mfaSecret);
    if (!secret) throw new ApiError("MFA_SECRET_UNREADABLE", "Stored MFA secret could not be read.", 500);
    if (!verifyTotp(secret, code)) {
      await recordSecurityEvent({
        userId: user.id,
        eventType: "mfa_enroll_failure",
        severity: "warning",
        ipAddress: meta.ip,
        details: { surface: "self_service" },
      });
      throw new ApiError("AUTH_MFA_INVALID", "That verification code is not valid.", 401);
    }
    await db.update(users).set({ mfaEnabled: true, updatedAt: new Date() }).where(eq(users.id, user.id));
    await recordAudit({
      eventType: "user.mfa.enabled",
      actorId: user.id,
      action: "update",
      targetType: "user",
      targetId: user.id,
      ipAddress: meta.ip,
      correlationId: meta.requestId,
    });
    await notifyUser({
      userId: user.id,
      type: "security",
      title: "Multi-factor authentication enabled",
      body: "TOTP verification is now required at every sign-in.",
      data: { deepLink: "/app/settings" },
    });
    return jsonOk({ enabled: true }, meta);
  }

  // disable
  const password = str(body, "password", { required: true, max: 200, label: "Password" })!;
  if (user.mfaRequired) {
    throw new ApiError(
      "MFA_REQUIRED_BY_POLICY",
      "An administrator requires MFA on this account. Contact the admin console.",
      403,
    );
  }
  if (!verifyPassword(password, user.passwordHash)) {
    throw new ApiError("AUTH_INVALID_CREDENTIALS", "Password is incorrect.", 401);
  }
  await db
    .update(users)
    .set({ mfaEnabled: false, mfaSecret: null, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await recordAudit({
    eventType: "user.mfa.disabled",
    actorId: user.id,
    action: "delete",
    targetType: "user",
    targetId: user.id,
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId: user.id,
    eventType: "mfa_disabled",
    severity: "warning",
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return jsonOk({ enabled: false }, meta);
});
