/** POST /api/auth/mfa — complete the second factor (TOTP, RFC 6238). */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { recordAudit, recordSecurityEvent } from "@/lib/audit";
import { getPendingSession } from "@/lib/auth";
import { decryptSecret, verifyTotp } from "@/lib/crypto";
import { ApiError, enforceRateLimit, jsonOk, readJson, route, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, meta) => {
  const session = await getPendingSession();
  if (!session) throw new ApiError("AUTH_REQUIRED", "Authentication required.", 401);
  if (session.mfaVerified) return jsonOk({ verified: true, next: "/app" }, meta);

  enforceRateLimit(`mfa:session:${session.sessionId}`, 8, 5 * 60_000);
  enforceRateLimit(`mfa:ip:${meta.ip}`, 20, 10 * 60_000);

  const body = await readJson(req);
  const code = str(body, "code", { required: true, min: 6, max: 6, label: "Verification code" })!;

  const rows = await db.select().from(users).where(eq(users.id, session.id)).limit(1);
  const user = rows[0];
  if (!user) throw new ApiError("AUTH_REQUIRED", "Authentication required.", 401);
  if (!user.mfaEnabled || !user.mfaSecret) {
    throw new ApiError("AUTH_MFA_NOT_ENROLLED", "Multi-factor authentication is not enrolled on this account.", 409);
  }

  const secret = decryptSecret(user.mfaSecret);
  if (!secret) {
    throw new ApiError("AUTH_MFA_SECRET_UNREADABLE", "Stored MFA secret could not be read.", 500);
  }

  if (!verifyTotp(secret, code)) {
    await recordSecurityEvent({
      userId: user.id,
      eventType: "mfa_failure",
      severity: "warning",
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      deviceId: session.deviceId,
    });
    throw new ApiError("AUTH_MFA_INVALID", "That verification code is not valid.", 401);
  }

  await db.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, session.sessionId));

  await recordAudit({
    eventType: "auth.mfa.verified",
    actorId: user.id,
    action: "verify",
    targetType: "session",
    targetId: session.sessionId,
    result: "success",
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId: user.id,
    eventType: "mfa_success",
    severity: "info",
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });

  return jsonOk({ verified: true, next: "/app" }, meta);
});
