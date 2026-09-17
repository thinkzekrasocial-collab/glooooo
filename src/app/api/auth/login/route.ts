/** POST /api/auth/login — email + password, followed by an optional MFA step. */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreferences, users } from "@/db/schema";
import { recordAudit, recordSecurityEvent } from "@/lib/audit";
import { createSession, getSessionUser, setSessionCookie } from "@/lib/auth";
import { verifyPassword } from "@/lib/crypto";
import { ApiError, enforceRateLimit, jsonOk, rateLimitHeaders, readJson, route, str } from "@/lib/http";
import { ensureBootstrap } from "@/lib/seed";

export const dynamic = "force-dynamic";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export const POST = route(async (req: NextRequest, meta) => {
  await ensureBootstrap();

  const limit = enforceRateLimit(`login:ip:${meta.ip}`, 20, 5 * 60_000);
  const body = await readJson(req);
  const email = str(body, "email", { required: true, max: 254, label: "Email" })!.toLowerCase();
  const password = str(body, "password", { required: true, max: 200, label: "Password" })!;

  enforceRateLimit(`login:email:${email}`, 8, 10 * 60_000);

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];

  if (!user || user.deletedAt) {
    await recordSecurityEvent({
      eventType: "login_failure",
      severity: "warning",
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      details: { email, reason: "unknown_account" },
    });
    await recordAudit({
      eventType: "auth.login",
      actorId: "anonymous",
      action: "login",
      result: "failure",
      reason: "unknown_account",
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      correlationId: meta.requestId,
    });
    throw new ApiError("AUTH_INVALID_CREDENTIALS", "Invalid email or password.", 401);
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await recordSecurityEvent({
      userId: user.id,
      eventType: "login_blocked_locked",
      severity: "critical",
      ipAddress: meta.ip,
      details: { lockedUntil: user.lockedUntil.toISOString() },
    });
    throw new ApiError(
      "AUTH_ACCOUNT_LOCKED",
      "Account temporarily locked after repeated failed attempts.",
      423,
      { retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000) },
    );
  }

  if (!verifyPassword(password, user.passwordHash)) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failed,
        lockedUntil: failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    await recordSecurityEvent({
      userId: user.id,
      eventType: "login_failure",
      severity: failed >= MAX_FAILED_ATTEMPTS ? "critical" : "warning",
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      details: { attempts: failed },
    });
    throw new ApiError("AUTH_INVALID_CREDENTIALS", "Invalid email or password.", 401, {
      attemptsRemaining: Math.max(MAX_FAILED_ATTEMPTS - failed, 0),
    });
  }

  if (user.status === "pending") {
    throw new ApiError(
      "AUTH_ACCOUNT_PENDING",
      "This account is provisioned but not yet activated. Contact an administrator.",
      403,
    );
  }
  if (user.status === "suspended") {
    await recordSecurityEvent({
      userId: user.id,
      eventType: "login_blocked_suspended",
      severity: "warning",
      ipAddress: meta.ip,
    });
    throw new ApiError("AUTH_ACCOUNT_SUSPENDED", "This account has been suspended.", 403);
  }
  if (user.status !== "active") {
    throw new ApiError("AUTH_ACCOUNT_INACTIVE", "This account is no longer active.", 403);
  }

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await db.insert(userPreferences).values({ userId: user.id }).onConflictDoNothing();

  const { token, sessionId, expiresAt } = await createSession(user.id, meta, {
    mfaVerified: !user.mfaEnabled,
  });
  await setSessionCookie(token, expiresAt);

  await recordAudit({
    eventType: "auth.login",
    actorId: user.id,
    action: "login",
    targetType: "user",
    targetId: user.id,
    result: "success",
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    correlationId: meta.requestId,
    details: { mfaEnabled: user.mfaEnabled },
  });
  await recordSecurityEvent({
    userId: user.id,
    eventType: "login_success",
    severity: "info",
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });

  const mfaRequired = Boolean(user.mfaEnabled);

  return jsonOk(
    {
      mfaRequired,
      sessionId,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        preferredName: user.preferredName,
        userType: user.userType,
        status: user.status,
        mfaEnabled: user.mfaEnabled,
        mfaRequired: user.mfaRequired,
      },
      next: mfaRequired ? "/auth/mfa" : "/app",
    },
    meta,
    200,
  );
});

/** Session probe for the SPA bootstrap path. */
export const GET = route(async (_req: NextRequest, meta) => {
  const session = await getSessionUser();
  if (!session) return jsonOk({ authenticated: false }, meta);
  return jsonOk({ authenticated: true, user: session }, meta);
});


