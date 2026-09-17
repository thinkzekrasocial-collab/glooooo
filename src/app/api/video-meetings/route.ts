import { NextRequest } from "next/server";
import { db } from "@/db";
import { videoMeetings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { uuid, randomToken } from "@/lib/crypto";
import { ApiError, enforceRateLimit, enumValue, jsonOk, readJson, route, str } from "@/lib/http";
import { activeMeetingForGroup, loadGroupAccess, loadAuthorizedGroup, safeMeeting } from "@/lib/video-meetings";
import { issueJitsiToken, jitsiBaseUrl } from "@/lib/jitsi";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, meta) => {
  const user = await requireUser();
  enforceRateLimit(`video:create:${user.id}`, 10, 60_000);
  const body = await readJson(req);
  const groupId = str(body, "groupId", { required: true, max: 128, label: "Group id" })!;
  const type = enumValue(body, "type", ["video", "voice"] as const, { required: true })!;
  const title = str(body, "title", { min: 2, max: 160, label: "Meeting title" }) ?? `${type === "video" ? "Video" : "Voice"} call`;
  const { group } = await loadAuthorizedGroup(user, groupId, type, "start");
  const existing = await activeMeetingForGroup(groupId);
  if (existing) {
    const token = issueJitsiToken({ roomName: existing.roomName, userId: user.id, displayName: user.firstName + " " + user.lastName, email: user.email, allowScreenSharing: group.screenSharingEnabled });
    return jsonOk({ meeting: safeMeeting(existing), conference: { domain: jitsiBaseUrl(), jwt: token.token, expiresAt: token.expiresAt.toISOString(), screenSharingEnabled: group.screenSharingEnabled } }, meta);
  }
  const meetingId = uuid();
  const roomName = `gbp-${randomToken(24)}`;
  let meeting;
  try {
    meeting = (await db.insert(videoMeetings).values({ id: meetingId, groupId, createdBy: user.id, roomName, meetingType: type, status: "active", title }).returning())[0];
  } catch (error) {
    const retry = await activeMeetingForGroup(groupId);
    if (retry) return jsonOk({ meeting: safeMeeting(retry) }, meta);
    throw error;
  }
  await recordAudit({ eventType: "meeting_created", actorId: user.id, actorRole: user.roles.join(","), action: "create", targetType: "video_meeting", targetId: meetingId, details: { groupId, type }, ipAddress: meta.ip, correlationId: meta.requestId });
  const token = issueJitsiToken({ roomName, userId: user.id, displayName: user.firstName + " " + user.lastName, email: user.email, allowScreenSharing: group.screenSharingEnabled });
  await recordAudit({ eventType: "meeting_token_issued", actorId: user.id, action: "issue", targetType: "video_meeting", targetId: meetingId, details: { expiresAt: token.expiresAt.toISOString() }, ipAddress: meta.ip, correlationId: meta.requestId });
  return jsonOk({ meeting: safeMeeting(meeting), conference: { domain: jitsiBaseUrl(), jwt: token.token, expiresAt: token.expiresAt.toISOString(), screenSharingEnabled: group.screenSharingEnabled } }, meta, 201);
});

export const GET = route(async (req: NextRequest, meta) => {
  const user = await requireUser();
  const groupId = new URL(req.url).searchParams.get("groupId");
  if (!groupId) throw new ApiError("VALIDATION_REQUIRED", "groupId is required.", 422);
  await loadGroupAccess(user, groupId);
  const meeting = await activeMeetingForGroup(groupId);
  return jsonOk({ meeting: meeting ? safeMeeting(meeting) : null }, meta);
});
