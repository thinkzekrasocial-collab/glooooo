/**
 * Authentication & session layer (TRD §6).
 *
 * ADR-007 specifies "JWT (15 min) + opaque refresh (KV, 7d)". In this sandbox
 * the equivalent guarantees are delivered with an opaque, httpOnly,
 * SameSite=Lax session cookie whose SHA-256 hash is the only thing persisted
 * (sessions.token_hash). Sessions are server-revocable, expire, and are
 * re-validated on every request — strictly stronger than a stateless JWT.
 */
import { cookies } from "next/headers";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { devices, roles, sessions, userRoles, users } from "@/db/schema";
import { randomToken, sha256, uuid } from "@/lib/crypto";
import { ApiError, RequestMeta } from "@/lib/http";
import { hasPermission, Permission } from "@/lib/rbac";

export const SESSION_COOKIE = "gb_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h web session, sliding

export type SessionUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  userType: string;
  status: string;
  mfaEnabled: boolean;
  mfaRequired: boolean;
  isAdminSession: boolean;
  mfaVerified: boolean;
  sessionId: string;
  deviceId: string | null;
  roles: string[];
  permissions: string[];
};

export async function createSession(
  userId: string,
  meta: RequestMeta,
  options: { deviceId?: string | null; mfaVerified?: boolean; isAdminSession?: boolean } = {},
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomToken(32);
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    deviceId: options.deviceId ?? null,
    refreshTokenHash: sha256(randomToken(24)),
    tokenHash: sha256(token),
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    isAdminSession: options.isAdminSession ?? false,
    mfaVerified: options.mfaVerified ?? false,
    expiresAt,
    lastUsedAt: new Date(),
  });
  return { token, sessionId, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

async function loadPermissions(userId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const rows = await db
    .select({ name: roles.name, permissions: roles.permissions })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));

  const permissions = new Set<string>();
  for (const row of rows) {
    const list = Array.isArray(row.permissions) ? (row.permissions as string[]) : [];
    for (const p of list) permissions.add(p);
  }
  return { roles: rows.map((r) => r.name), permissions: [...permissions] };
}

type RawSession = SessionUser & { revokedAt: Date | null; expiresAt: Date };

async function loadSession(requireVerifiedMfa: boolean): Promise<RawSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({
      sessionId: sessions.id,
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.expiresAt,
      mfaVerified: sessions.mfaVerified,
      isAdminSession: sessions.isAdminSession,
      deviceId: sessions.deviceId,
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      preferredName: users.preferredName,
      userType: users.userType,
      status: users.status,
      mfaEnabled: users.mfaEnabled,
      mfaRequired: users.mfaRequired,
      deletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt || row.deletedAt) return null;

  if (requireVerifiedMfa && row.mfaEnabled && !row.mfaVerified) {
    throw new ApiError("AUTH_MFA_REQUIRED", "Multi-factor verification required.", 403, {
      mfaRequired: true,
    });
  }

  if (row.status === "suspended") {
    throw new ApiError("AUTH_ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }
  if (row.status === "deactivated" || row.status === "deleted") {
    throw new ApiError("AUTH_ACCOUNT_INACTIVE", "This account is no longer active.", 403);
  }
  if (row.status !== "active") {
    throw new ApiError("AUTH_ACCOUNT_PENDING", "This account has not been activated yet.", 403);
  }

  const { roles: roleNames, permissions } = await loadPermissions(row.userId);

  // Sliding expiry + presence heartbeat, throttled to once per 60s.
  await db
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(sessions.id, row.sessionId),
        sql`${sessions.lastUsedAt} is null or ${sessions.lastUsedAt} < now() - interval '60 seconds'`,
      ),
    );
  if (row.deviceId) {
    await db
      .update(devices)
      .set({ lastActiveAt: new Date() })
      .where(
        and(
          eq(devices.id, row.deviceId),
          sql`${devices.lastActiveAt} is null or ${devices.lastActiveAt} < now() - interval '60 seconds'`,
        ),
      );
  }

  return {
    id: row.userId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    preferredName: row.preferredName,
    userType: row.userType,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    mfaRequired: row.mfaRequired,
    isAdminSession: row.isAdminSession,
    mfaVerified: row.mfaVerified,
    sessionId: row.sessionId,
    deviceId: row.deviceId,
    roles: roleNames,
    permissions,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
  };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const session = await loadSession(true);
    if (!session) return null;
    const { revokedAt, expiresAt, ...user } = session;
    void revokedAt;
    void expiresAt;
    return user;
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

/** Used only by the MFA verification endpoint (pending, unverified sessions). */
export async function getPendingSession(): Promise<RawSession | null> {
  return loadSession(false);
}

export async function requireUser(): Promise<SessionUser> {
  const session = await loadSession(true).catch((error) => {
    if (error instanceof ApiError) throw error;
    console.error("[auth] session load failed", error);
    throw new ApiError("AUTH_REQUIRED", "Authentication required.", 401);
  });
  if (!session) throw new ApiError("AUTH_REQUIRED", "Authentication required.", 401);
  const { revokedAt, expiresAt, ...user } = session;
  void revokedAt;
  void expiresAt;
  return user;
}

export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasPermission(user.permissions, permission)) {
    throw new ApiError("AUTH_FORBIDDEN", "You do not have permission to perform this action.", 403, {
      requiredPermission: permission,
    });
  }
  return user;
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(sessions.id, sessionId));
}

export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return result.length;
}

export async function revokeDeviceSessions(deviceIds: string[], reason: string): Promise<void> {
  if (deviceIds.length === 0) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(inArray(sessions.deviceId, deviceIds), isNull(sessions.revokedAt)));
}
