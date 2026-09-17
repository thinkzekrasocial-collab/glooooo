/** GET/POST /api/users/me/security — session & device management (self-service). */
import { NextRequest } from "next/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { devices, sessions } from "@/db/schema";
import { recordAudit, recordSecurityEvent } from "@/lib/audit";
import { requireUser, revokeAllSessions, revokeDeviceSessions } from "@/lib/auth";
import { listUserDevices, listUserSessions } from "@/lib/data";
import { ApiError, enumValue, jsonOk, readJson, route, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, meta) => {
  const session = await requireUser();
  const [sessionRows, deviceRows] = await Promise.all([
    listUserSessions(session.id),
    listUserDevices(session.id),
  ]);
  return jsonOk(
    {
      sessions: sessionRows.map((row) => ({ ...row, current: row.id === session.sessionId })),
      devices: deviceRows.map((row) => ({ ...row, current: row.id === session.deviceId })),
    },
    meta,
  );
});

export const POST = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  const body = await readJson(req);
  const action = enumValue(
    body,
    "action",
    ["revoke_session", "revoke_device", "revoke_other_sessions"] as const,
    { required: true },
  )!;

  if (action === "revoke_other_sessions") {
    const revoked = await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "user_revoked_other_sessions" })
      .where(and(eq(sessions.userId, session.id), ne(sessions.id, session.sessionId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    await recordAudit({
      eventType: "security.sessions_revoked",
      actorId: session.id,
      action: "revoke",
      targetType: "user",
      targetId: session.id,
      details: { count: revoked.length },
      ipAddress: meta.ip,
      correlationId: meta.requestId,
    });
    return jsonOk({ ok: true, revoked: revoked.length }, meta);
  }

  if (action === "revoke_session") {
    const sessionId = str(body, "sessionId", { required: true, max: 64 })!;
    if (sessionId === session.sessionId) {
      throw new ApiError("SECURITY_CANNOT_REVOKE_CURRENT", "Use sign out to end the current session.", 422);
    }
    const target = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, session.id)))
      .limit(1);
    if (target.length === 0) throw new ApiError("SESSION_NOT_FOUND", "Session not found.", 404);
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "user_revoked_session" })
      .where(eq(sessions.id, sessionId));
    await recordAudit({
      eventType: "security.session_revoked",
      actorId: session.id,
      action: "revoke",
      targetType: "session",
      targetId: sessionId,
      ipAddress: meta.ip,
      correlationId: meta.requestId,
    });
    return jsonOk({ ok: true }, meta);
  }

  const deviceId = str(body, "deviceId", { required: true, max: 64 })!;
  const target = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, session.id)))
    .limit(1);
  if (target.length === 0) throw new ApiError("DEVICE_NOT_FOUND", "Device not found.", 404);

  await db
    .update(devices)
    .set({ status: "revoked", revokedAt: new Date(), revokedBy: session.id })
    .where(eq(devices.id, deviceId));
  await revokeDeviceSessions([deviceId], "device_revoked");
  await recordAudit({
    eventType: "security.device_revoked",
    actorId: session.id,
    action: "revoke",
    targetType: "device",
    targetId: deviceId,
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId: session.id,
    eventType: "device_revoked",
    severity: "warning",
    deviceId,
    ipAddress: meta.ip,
  });
  return jsonOk({ ok: true }, meta);
});
