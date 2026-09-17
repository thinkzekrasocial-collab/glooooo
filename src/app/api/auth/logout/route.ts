/** POST /api/auth/logout — revoke the current session, or all sessions. */
import { NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { clearSessionCookie, getSessionUser, revokeAllSessions, revokeSession } from "@/lib/auth";
import { boolValue, jsonOk, readJson, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, meta) => {
  const session = await getSessionUser();
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const all = boolValue(body, "all") ?? false;

  if (session) {
    if (all) {
      const revoked = await revokeAllSessions(session.id, "user_logout_all");
      await recordAudit({
        eventType: "auth.logout_all",
        actorId: session.id,
        action: "revoke",
        targetType: "user",
        targetId: session.id,
        details: { sessionsRevoked: revoked },
        ipAddress: meta.ip,
        correlationId: meta.requestId,
      });
    } else {
      await revokeSession(session.sessionId, "user_logout");
      await recordAudit({
        eventType: "auth.logout",
        actorId: session.id,
        action: "revoke",
        targetType: "session",
        targetId: session.sessionId,
        ipAddress: meta.ip,
        correlationId: meta.requestId,
      });
    }
  }

  await clearSessionCookie();
  return jsonOk({ ok: true }, meta);
});
