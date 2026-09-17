/**
 * GlobeBridge Pathways — Private Encrypted Messenger
 * Database schema (Drizzle ORM / PostgreSQL runtime target for this sandbox).
 *
 * The TRD specifies Cloudflare D1 (SQLite). This sandbox runs Next.js +
 * PostgreSQL, so the schema is a faithful 1:1 port:
 *   TEXT UUID        -> text (uuid)
 *   BLOB             -> text (base64)  [ciphertext / wrapped keys never plaintext]
 *   INTEGER 0|1      -> boolean
 *   TEXT JSON        -> jsonb
 *   DATETIME('now')  -> timestamp with time zone default now()
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ═══════════════════════════ USERS ═══════════════════════════ */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    preferredName: text("preferred_name"),
    phoneNumber: text("phone_number"),
    studentId: text("student_id").unique(),
    employeeId: text("employee_id").unique(),
    externalId: text("external_id"),
    dateOfBirth: text("date_of_birth"),
    profilePhotoKey: text("profile_photo_key"),
    userType: text("user_type").notNull().default("student"),
    status: text("status").notNull().default("pending"),
    department: text("department"),
    gradeClass: text("grade_class"),
    program: text("program"),
    campusLocation: text("campus_location"),
    enrollmentInfo: jsonb("enrollment_info"),
    emergencyContact: jsonb("emergency_contact"),
    notes: text("notes"),
    accountExpiresAt: timestamp("account_expires_at", { withTimezone: true }),
    mfaRequired: boolean("mfa_required").notNull().default(false),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecret: text("mfa_secret"),
    messagingPerms: jsonb("messaging_perms").notNull().default({}),
    /** TRD §1.3 layer 3 — a user row cannot exist without an admin reference. */
    createdByAdminId: text("created_by_admin_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [
    index("idx_users_status").on(t.status),
    index("idx_users_type").on(t.userType),
    index("idx_users_created_by").on(t.createdByAdminId),
  ],
);

/* ═══════════════════════════ ROLES ═══════════════════════════ */
export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false),
  permissions: jsonb("permissions").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedBy: text("assigned_by").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index("idx_ur_role").on(t.roleId),
  ],
);

/* ═══════════════════════════ GROUPS ═══════════════════════════ */
export const groups = pgTable(
  "groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    groupType: text("group_type").notNull().default("custom"),
    avatarKey: text("avatar_key"),
    status: text("status").notNull().default("draft"),
    visibility: text("visibility").notNull().default("private"),
    maxMembers: integer("max_members"),
    messagingPerms: jsonb("messaging_perms").notNull().default({}),
    fileSharingEnabled: boolean("file_sharing_enabled").notNull().default(true),
    voiceVideoEnabled: boolean("voice_video_enabled").notNull().default(false),
    videoCallsEnabled: boolean("video_calls_enabled").notNull().default(false),
    voiceCallsEnabled: boolean("voice_calls_enabled").notNull().default(false),
    callStartPermission: text("call_start_permission").notNull().default("admin_only"),
    callJoinPermission: text("call_join_permission").notNull().default("group_members"),
    screenSharingEnabled: boolean("screen_sharing_enabled").notNull().default(false),
    maxCallParticipants: integer("max_call_participants"),
    retentionPolicyDays: integer("retention_policy_days"),
    announcementOnly: boolean("announcement_only").notNull().default(false),
    createdByAdminId: text("created_by_admin_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("idx_groups_status").on(t.status), index("idx_groups_type").on(t.groupType)],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    memberRole: text("member_role").notNull().default("member"),
    addedBy: text("added_by").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("idx_gm_user").on(t.userId),
    index("idx_gm_group").on(t.groupId),
  ],
);

/* ═══════════════════════ CONVERSATIONS ═══════════════════════ */
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull().default("direct"),
    groupId: text("group_id").references(() => groups.id),
    title: text("title"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_conv_group").on(t.groupId),
    index("idx_conv_status").on(t.status),
    index("idx_conv_last_msg").on(t.lastMessageAt),
  ],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("participant"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    archived: boolean("archived").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index("idx_cm_user").on(t.userId),
    index("idx_cm_conv").on(t.conversationId),
  ],
);

/* ═══════════════════════════ MESSAGES ═══════════════════════════ */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    senderId: text("sender_id").notNull(),
    senderDeviceId: text("sender_device_id").notNull(),
    clientMessageId: text("client_message_id").notNull(),
    contentType: text("content_type").notNull().default("text"),
    /** E2EE payload: base64 AES-256-GCM ciphertext. Server never sees plaintext. */
    ciphertext: text("ciphertext").notNull(),
    ciphertextIv: text("ciphertext_iv").notNull(),
    ciphertextVersion: integer("ciphertext_version").notNull().default(1),
    contentHash: text("content_hash"),
    /** Metadata only (system notices). Never used for member-authored text. */
    systemText: text("system_text"),
    replyToId: text("reply_to_id"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    status: text("status").notNull().default("sent"),
    serverTimestamp: timestamp("server_timestamp", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_msg_conv_time").on(t.conversationId, t.serverTimestamp),
    index("idx_msg_sender").on(t.senderId),
    index("idx_msg_status").on(t.status),
    uniqueIndex("uq_client_msg").on(t.conversationId, t.clientMessageId),
  ],
);

export const messageRecipients = pgTable(
  "message_recipients",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.deviceId] }),
    index("idx_mr_user").on(t.userId),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    uploaderId: text("uploader_id").notNull(),
    fileName: text("file_name").notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    mimeType: text("mime_type").notNull(),
    /** Object key inside the encrypted blob store (R2 binding in production). */
    r2Key: text("r2_key").notNull(),
    /** Client-encrypted payload (base64). Kept small in this sandbox build. */
    storedPayload: text("stored_payload"),
    encryptionKeyId: text("encryption_key_id"),
    scanStatus: text("scan_status").notNull().default("clean"),
    scanCompletedAt: timestamp("scan_completed_at", { withTimezone: true }),
    checksumSha256: text("checksum_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("idx_att_message").on(t.messageId), index("idx_att_uploader").on(t.uploaderId)],
);

/* ═══════════════════════ DEVICES & KEYS ═══════════════════════ */
export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceName: text("device_name").notNull(),
    deviceType: text("device_type").notNull().default("web"),
    browserInfo: text("browser_info"),
    publicIdentityKey: text("public_identity_key").notNull(),
    publicSignedKey: text("public_signed_key").notNull(),
    pushSubscription: jsonb("push_subscription"),
    status: text("status").notNull().default("active"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (t) => [index("idx_dev_user").on(t.userId), index("idx_dev_status").on(t.status)],
);

export const encryptionKeys = pgTable(
  "encryption_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    keyType: text("key_type").notNull().default("identity"),
    publicKey: text("public_key").notNull(),
    keyId: integer("key_id"),
    signature: text("signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_ek_user_device").on(t.userId, t.deviceId),
    index("idx_ek_type").on(t.keyType),
  ],
);

/** Per-device wrapped copy of a conversation's symmetric key (ECDH+HKDF+AES-GCM wrap). */
export const conversationKeyWraps = pgTable(
  "conversation_key_wraps",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    recipientDeviceId: text("recipient_device_id").notNull(),
    recipientUserId: text("recipient_user_id").notNull(),
    senderDeviceId: text("sender_device_id").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    wrappedKeyIv: text("wrapped_key_iv").notNull(),
    wrapVersion: integer("wrap_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.recipientDeviceId] }),
    index("idx_ckw_user").on(t.recipientUserId),
  ],
);

/* ═══════════════════════ SESSIONS & AUTH ═══════════════════════ */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    tokenHash: text("token_hash").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    isAdminSession: boolean("is_admin_session").notNull().default(false),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    index("idx_sess_user").on(t.userId),
    uniqueIndex("idx_sess_token").on(t.tokenHash),
    index("idx_sess_refresh").on(t.refreshTokenHash),
    index("idx_sess_expires").on(t.expiresAt),
  ],
);

/* ═══════════════════════════ OTHER ═══════════════════════════ */
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    userType: text("user_type").notNull().default("student"),
    roleId: text("role_id").notNull(),
    invitedByAdminId: text("invited_by_admin_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("created"),
    assignedGroups: jsonb("assigned_groups").notNull().default([]),
    permissionsConfig: jsonb("permissions_config").notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_inv_email").on(t.email),
    index("idx_inv_status").on(t.status),
    index("idx_inv_token").on(t.tokenHash),
    index("idx_inv_expires").on(t.expiresAt),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    action: text("action").notNull(),
    details: jsonb("details").notNull().default({}),
    ipAddress: text("ip_address"),
    deviceId: text("device_id"),
    userAgent: text("user_agent"),
    correlationId: text("correlation_id"),
    result: text("result").notNull().default("success"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_audit_actor").on(t.actorId),
    index("idx_audit_target").on(t.targetType, t.targetId),
    index("idx_audit_type").on(t.eventType),
    index("idx_audit_time").on(t.createdAt),
  ],
);

export const securityEvents = pgTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    eventType: text("event_type").notNull(),
    severity: text("severity").notNull().default("info"),
    ipAddress: text("ip_address"),
    deviceId: text("device_id"),
    userAgent: text("user_agent"),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_se_user").on(t.userId),
    index("idx_se_type").on(t.eventType),
    index("idx_se_time").on(t.createdAt),
    index("idx_se_severity").on(t.severity),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    data: jsonb("data").notNull().default({}),
    channel: text("channel").notNull().default("in_app"),
    status: text("status").notNull().default("sent"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_notif_user").on(t.userId, t.createdAt),
    index("idx_notif_status").on(t.status),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporter_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason").notNull(),
    description: text("description"),
    /** Voluntary plaintext supplied by the reporter (TRD §17 abuse review path). */
    submittedContent: text("submitted_content"),
    status: text("status").notNull().default("pending"),
    assignedTo: text("assigned_to"),
    resolutionNotes: text("resolution_notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_report_status").on(t.status),
    index("idx_report_target").on(t.targetType, t.targetId),
  ],
);

export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const blockedUsers = pgTable(
  "blocked_users",
  {
    blockerId: text("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  notificationSettings: jsonb("notification_settings").notNull().default({
    directMessages: true,
    groupMessages: true,
    mentions: true,
    securityAlerts: true,
    pushEnabled: true,
    emailEnabled: false,
  }),
  privacySettings: jsonb("privacy_settings").notNull().default({
    readReceipts: true,
    typingIndicators: true,
    onlineStatus: true,
    profileVisibility: "group_members",
  }),
  theme: text("theme").notNull().default("system"),
  language: text("language").notNull().default("en"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Ephemeral typing/presence pings (Durable Object state in production). */
export const typingIndicators = pgTable(
  "typing_indicators",
  {
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

/* ═════════════════════ VIDEO CONFERENCING ═════════════════════
 * Application metadata only. Audio, video, SDP, recordings and media packets
 * never enter this database; Jitsi is the media infrastructure boundary.
 */
export const videoMeetings = pgTable(
  "video_meetings",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull().references(() => users.id),
    roomName: text("room_name").notNull().unique(),
    meetingType: text("meeting_type").notNull().default("video"),
    status: text("status").notNull().default("active"),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_video_meetings_group").on(t.groupId),
    index("idx_video_meetings_creator").on(t.createdBy),
    index("idx_video_meetings_status").on(t.status),
    index("idx_video_meetings_room").on(t.roomName),
    index("idx_video_meetings_created").on(t.createdAt),
  ],
);

export const videoMeetingParticipants = pgTable(
  "video_meeting_participants",
  {
    id: text("id").primaryKey(),
    meetingId: text("meeting_id").notNull().references(() => videoMeetings.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("participant"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    status: text("status").notNull().default("invited"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_video_participants_meeting").on(t.meetingId),
    index("idx_video_participants_user").on(t.userId),
    index("idx_video_participants_status").on(t.meetingId, t.status),
    uniqueIndex("uq_video_participant").on(t.meetingId, t.userId),
  ],
);
