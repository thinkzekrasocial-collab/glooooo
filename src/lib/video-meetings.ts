import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { groupMembers, groups, users, videoMeetingParticipants, videoMeetings } from "@/db/schema";
import { ApiError } from "@/lib/http";
import { hasPermission, PERMISSIONS } from "@/lib/rbac";

export type MeetingType = "video" | "voice";

export async function loadAuthorizedGroup(
  user: { id: string; permissions: string[]; userType?: string },
  groupId: string,
  type: MeetingType,
  action: "start" | "join",
  meetingId?: string,
) {
  const rows = await db.select().from(groups).where(and(eq(groups.id, groupId), isNull(groups.deletedAt))).limit(1);
  const group = rows[0];
  if (!group || group.status !== "active") throw new ApiError("GROUP_NOT_FOUND", "Group not found.", 404);
  const membership = await db.select({ memberRole: groupMembers.memberRole }).from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id), isNull(groupMembers.removedAt))).limit(1);
  const isAdmin = hasPermission(user.permissions, PERMISSIONS.groupsUpdate) || user.permissions.includes("*");
  const invited = action === "join" && meetingId
    ? (await db.select({ id: videoMeetingParticipants.id }).from(videoMeetingParticipants).where(and(eq(videoMeetingParticipants.meetingId, meetingId), eq(videoMeetingParticipants.userId, user.id), eq(videoMeetingParticipants.status, "invited"))).limit(1)).length > 0
    : false;
  if (!membership[0] && !isAdmin && !invited) throw new ApiError("GROUP_MEMBERSHIP_REQUIRED", "You are not a member of this group.", 403);
  if (type === "video" && !group.videoCallsEnabled && !isAdmin) throw new ApiError("VIDEO_CALLS_DISABLED", "Video calls are disabled for this group.", 403);
  if (type === "voice" && !group.voiceCallsEnabled && !isAdmin) throw new ApiError("VOICE_CALLS_DISABLED", "Voice calls are disabled for this group.", 403);
  const policy = action === "start" ? group.callStartPermission : group.callJoinPermission;
  const allowed = isAdmin ||
    (policy === "group_members" && Boolean(membership[0])) ||
    (policy === "admins_and_members" && Boolean(membership[0])) ||
    (policy === "invited_members" && (Boolean(membership[0]) || invited)) ||
    (policy === "staff_and_admin" && ["admin", "teacher", "staff", "counselor"].includes(user.userType ?? ""));
  if (!allowed) throw new ApiError("CALL_PERMISSION_DENIED", `You are not authorized to ${action} this conference.`, 403);
  return { group, membership: membership[0] ?? null, isAdmin };
}

export async function loadGroupAccess(user: { id: string; permissions: string[] }, groupId: string) {
  const rows = await db.select().from(groups).where(and(eq(groups.id, groupId), isNull(groups.deletedAt))).limit(1);
  const group = rows[0];
  if (!group || group.status !== "active") throw new ApiError("GROUP_NOT_FOUND", "Group not found.", 404);
  const membership = await db.select({ memberRole: groupMembers.memberRole }).from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id), isNull(groupMembers.removedAt))).limit(1);
  if (!membership[0] && !user.permissions.includes("*")) throw new ApiError("GROUP_MEMBERSHIP_REQUIRED", "You are not a member of this group.", 403);
  return group;
}

export async function activeMeetingForGroup(groupId: string) {
  const rows = await db.select().from(videoMeetings).where(and(eq(videoMeetings.groupId, groupId), eq(videoMeetings.status, "active"))).orderBy(desc(videoMeetings.createdAt)).limit(1);
  return rows[0] ?? null;
}

export async function loadMeeting(id: string) {
  const rows = await db.select({ meeting: videoMeetings, group: groups }).from(videoMeetings).innerJoin(groups, eq(groups.id, videoMeetings.groupId)).where(eq(videoMeetings.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.group.deletedAt) throw new ApiError("MEETING_NOT_FOUND", "Meeting not found.", 404);
  return row;
}

export async function participantCount(meetingId: string): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(videoMeetingParticipants).where(and(eq(videoMeetingParticipants.meetingId, meetingId), eq(videoMeetingParticipants.status, "joined")));
  return Number(rows[0]?.count ?? 0);
}

export function safeMeeting(meeting: typeof videoMeetings.$inferSelect) {
  return { id: meeting.id, groupId: meeting.groupId, roomName: meeting.roomName, type: meeting.meetingType, title: meeting.title, status: meeting.status, createdBy: meeting.createdBy, createdAt: meeting.createdAt.toISOString(), startedAt: meeting.startedAt.toISOString(), endedAt: meeting.endedAt?.toISOString() ?? null };
}

export function displayName(user: typeof users.$inferSelect): string {
  return user.preferredName?.trim() || `${user.firstName} ${user.lastName}`.trim() || user.email;
}
