import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users, videoMeetingParticipants, videoMeetings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { uuid } from "@/lib/crypto";
import { ApiError, enforceRateLimit, jsonOk, route } from "@/lib/http";
import { displayName, loadAuthorizedGroup, loadMeeting, participantCount, safeMeeting } from "@/lib/video-meetings";
import { issueJitsiToken, jitsiBaseUrl } from "@/lib/jitsi";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function authorizeMeeting(id: string) {
  const user = await requireUser();
  const { meeting, group } = await loadMeeting(id);
  const auth = await loadAuthorizedGroup(user, group.id, meeting.meetingType as "video" | "voice", "join", meeting.id);
  return { user, meeting, group, auth };
}

export const GET = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const { user, meeting, group } = await authorizeMeeting((await ctx.params).id);
  return jsonOk({ meeting: safeMeeting(meeting), group: { id: group.id, name: group.name }, canEnd: meeting.createdBy === user.id || user.permissions.includes("*") || user.permissions.includes("groups.update") }, meta);
});

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const id = (await ctx.params).id;
  const action = req.nextUrl.searchParams.get("action");
  if (!action || !["join", "leave", "end"].includes(action)) throw new ApiError("VALIDATION_ENUM", "action must be join, leave, or end.", 422);
  const { user, meeting, group, auth } = await authorizeMeeting(id);
  enforceRateLimit(`video:${action}:${user.id}`, action === "join" ? 30 : 20, 60_000);
  if (action === "end") {
    if (meeting.createdBy !== user.id && !auth.isAdmin) throw new ApiError("CALL_HOST_REQUIRED", "Only the host or an administrator can end this conference.", 403);
    if (meeting.status === "active") {
      await db.update(videoMeetings).set({ status: "ended", endedAt: new Date(), endedReason: "explicit", updatedAt: new Date() }).where(and(eq(videoMeetings.id, id), eq(videoMeetings.status, "active")));
      await recordAudit({ eventType: "meeting_ended", actorId: user.id, actorRole: user.roles.join(","), action: "end", targetType: "video_meeting", targetId: id, details: { groupId: group.id }, ipAddress: meta.ip, correlationId: meta.requestId });
    }
    return jsonOk({ ok: true, meeting: { ...safeMeeting(meeting), status: "ended" } }, meta);
  }
  if (meeting.status !== "active") throw new ApiError("MEETING_ENDED", "This conference is no longer available.", 409);
  if (action === "join") {
    const count = await participantCount(id);
    if (group.maxCallParticipants && count >= group.maxCallParticipants) throw new ApiError("CALL_FULL", "This conference has reached its participant limit.", 409);
    const existing = await db.select({ id: videoMeetingParticipants.id }).from(videoMeetingParticipants).where(and(eq(videoMeetingParticipants.meetingId, id), eq(videoMeetingParticipants.userId, user.id))).limit(1);
    if (existing[0]) await db.update(videoMeetingParticipants).set({ status: "joined", joinedAt: new Date(), leftAt: null, updatedAt: new Date() }).where(eq(videoMeetingParticipants.id, existing[0].id));
    else await db.insert(videoMeetingParticipants).values({ id: uuid(), meetingId: id, userId: user.id, role: meeting.createdBy === user.id ? "host" : "participant", status: "joined", joinedAt: new Date() });
    const dbUser = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
    const token = issueJitsiToken({ roomName: meeting.roomName, userId: user.id, displayName: displayName(dbUser), email: dbUser.email, avatarUrl: dbUser.profilePhotoKey, allowScreenSharing: group.screenSharingEnabled });
    await recordAudit({ eventType: "meeting_joined", actorId: user.id, actorRole: user.roles.join(","), action: "join", targetType: "video_meeting", targetId: id, details: { groupId: group.id }, ipAddress: meta.ip, correlationId: meta.requestId });
    return jsonOk({ meeting: safeMeeting(meeting), group: { id: group.id, name: group.name }, conference: { domain: jitsiBaseUrl(), jwt: token.token, expiresAt: token.expiresAt.toISOString(), meetingType: meeting.meetingType, screenSharingEnabled: group.screenSharingEnabled, displayName: displayName(dbUser), email: dbUser.email } }, meta);
  }
  await db.update(videoMeetingParticipants).set({ status: "left", leftAt: new Date(), updatedAt: new Date() }).where(and(eq(videoMeetingParticipants.meetingId, id), eq(videoMeetingParticipants.userId, user.id), isNull(videoMeetingParticipants.leftAt)));
  await recordAudit({ eventType: "meeting_left", actorId: user.id, actorRole: user.roles.join(","), action: "leave", targetType: "video_meeting", targetId: id, details: { groupId: group.id }, ipAddress: meta.ip, correlationId: meta.requestId });
  return jsonOk({ ok: true }, meta);
});
