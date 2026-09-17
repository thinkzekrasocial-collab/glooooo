/**
 * Bootstrap / seed routine (TRD §1.3 — no public registration).
 *
 * Idempotent. Invoked lazily by the auth entry points and exposed through
 * POST /api/setup. Creates system roles, platform settings and — for this
 * sandbox — a small set of operator-provisioned demo accounts, exactly as an
 * administrator would create them in the Admin Control Plane.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  conversationMembers,
  conversations,
  groupMembers,
  groups,
  messages,
  notifications,
  platformSettings,
  reports,
  roles,
  userPreferences,
  userRoles,
  users,
} from "@/db/schema";
import { hashPassword, uuid } from "@/lib/crypto";
import { SYSTEM_ROLES } from "@/lib/rbac";

const BOOTSTRAP_VERSION = "3";

export const DEMO_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "GlobeBridge#2026!";

export const DEMO_ACCOUNTS = [
  {
    email: process.env.ADMIN_BOOTSTRAP_EMAIL ?? "admin@globebridge.edu",
    name: "Amara Okonjo",
    role: "super_admin",
    label: "Platform owner — full admin console",
  },
  { email: "marcus.lee@globebridge.edu", name: "Marcus Lee", role: "teacher", label: "Teacher — directory + reports visibility" },
  { email: "alina.rahman@globebridge.edu", name: "Alina Rahman", role: "student", label: "Exchange student — messaging only" },
  { email: "priya.nair@globebridge.edu", name: "Priya Nair", role: "counselor", label: "Counselor — caseload visibility" },
];

const DEMO_USERS = [
  {
    email: "alina.rahman@globebridge.edu",
    firstName: "Alina",
    lastName: "Rahman",
    userType: "student",
    gradeClass: "Grade 11A",
    program: "Global Exchange 2026",
    department: null as string | null,
    status: "active",
    studentId: "GB-11A-0142",
  },
  {
    email: "marcus.lee@globebridge.edu",
    firstName: "Marcus",
    lastName: "Lee",
    userType: "teacher",
    gradeClass: null,
    program: null,
    department: "Mathematics",
    status: "active",
    employeeId: "GB-EMP-0091",
  },
  {
    email: "priya.nair@globebridge.edu",
    firstName: "Priya",
    lastName: "Nair",
    userType: "counselor",
    gradeClass: null,
    program: null,
    department: "Student Wellbeing",
    status: "active",
    employeeId: "GB-EMP-0044",
  },
  {
    email: "jonas.weber@globebridge.edu",
    firstName: "Jonas",
    lastName: "Weber",
    userType: "staff",
    gradeClass: null,
    program: null,
    department: "IT Services",
    status: "active",
    employeeId: "GB-EMP-0120",
  },
  {
    email: "sofia.alvarez@globebridge.edu",
    firstName: "Sofia",
    lastName: "Alvarez",
    userType: "mentor",
    gradeClass: null,
    program: "Global Exchange 2026",
    department: null,
    status: "active",
    employeeId: "GB-EMP-0210",
  },
  {
    email: "dev.patel@globebridge.edu",
    firstName: "Dev",
    lastName: "Patel",
    userType: "student",
    gradeClass: "Grade 10B",
    program: "Local Cohort",
    department: null,
    status: "pending",
    studentId: "GB-10B-0311",
  },
];

const DEMO_GROUPS = [
  { name: "Grade 11 Advisory", groupType: "advisory", description: "Daily advisory circle for Grade 11A.", status: "active", members: ["alina.rahman@globebridge.edu", "marcus.lee@globebridge.edu", "priya.nair@globebridge.edu"] },
  { name: "Global Exchange 2026", groupType: "program", description: "Inbound exchange cohort, host families and coordinators.", status: "active", members: ["alina.rahman@globebridge.edu", "sofia.alvarez@globebridge.edu", "marcus.lee@globebridge.edu"] },
  { name: "Mathematics Department", groupType: "department", description: "Faculty coordination.", status: "active", members: ["marcus.lee@globebridge.edu", "jonas.weber@globebridge.edu"] },
  { name: "Wellbeing Circle", groupType: "custom", description: "Safeguarding & wellbeing leads. Draft until approved.", status: "draft", members: ["priya.nair@globebridge.edu"] },
];

const SYSTEM_TEXT_CREATED =
  "Encrypted channel provisioned by the GlobeBridge admin control plane. Messages are end-to-end encrypted — the server stores ciphertext only.";

export type BootstrapResult = {
  bootstrapped: boolean;
  adminEmail: string;
  demoAccounts: typeof DEMO_ACCOUNTS;
};

async function upsertSystemRoles(): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    await db
      .insert(roles)
      .values({
        id: role.id,
        name: role.name,
        description: role.description,
        isSystem: true,
        permissions: role.permissions,
      })
      .onConflictDoUpdate({
        target: roles.id,
        set: {
          name: role.name,
          description: role.description,
          isSystem: true,
          permissions: role.permissions,
          updatedAt: new Date(),
        },
      });
  }
}

async function upsertSettings(adminId: string): Promise<void> {
  const defaults: Array<{ key: string; value: unknown; description: string }> = [
    { key: "registration.public_signup_enabled", value: false, description: "Fundamental rule: never public self-registration." },
    { key: "registration.require_admin_approval", value: true, description: "Invitations must be issued by an administrator." },
    { key: "messaging.direct_messaging_enabled", value: true, description: "Allow 1:1 conversations between provisioned accounts." },
    { key: "messaging.file_sharing_enabled", value: true, description: "Allow client-encrypted attachments." },
    { key: "messaging.retention_days", value: 365, description: "Retention window applied to message metadata cleanup." },
    { key: "security.session_ttl_hours", value: 12, description: "Web session lifetime before re-authentication." },
    { key: "security.require_mfa_for_admins", value: true, description: "Admins must enrol TOTP before using the console." },
    { key: "security.max_login_attempts", value: 5, description: "Failed attempts before temporary lockout." },
    { key: "notifications.push_enabled", value: true, description: "Web Push (VAPID) dispatch for offline members." },
    { key: "bootstrap.version", value: BOOTSTRAP_VERSION, description: "Sandbox seed marker." },
  ];

  for (const item of defaults) {
    await db
      .insert(platformSettings)
      .values({ key: item.key, value: item.value, description: item.description, updatedBy: adminId })
      .onConflictDoNothing({ target: platformSettings.key });
  }
}

export async function ensureBootstrap(): Promise<BootstrapResult> {
  await upsertSystemRoles();

  const superAdminRole = SYSTEM_ROLES[0];
  const adminEmail = process.env.ADMIN_BOOTSTRAP_EMAIL ?? "admin@globebridge.edu";

  const existingAdmin = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(eq(userRoles.roleId, superAdminRole.id))
    .limit(1);

  let adminId = existingAdmin[0]?.id;

  if (!adminId) {
    adminId = uuid();
    await db
      .insert(users)
      .values({
        id: adminId,
        email: adminEmail,
        passwordHash: hashPassword(DEMO_PASSWORD),
        firstName: "Amara",
        lastName: "Okonjo",
        preferredName: "Amara",
        userType: "admin",
        status: "active",
        department: "Student Services",
        studentId: null,
        createdByAdminId: adminId,
        mfaRequired: false,
      })
      .onConflictDoNothing({ target: users.email });
    await db
      .insert(userRoles)
      .values({ userId: adminId, roleId: superAdminRole.id, assignedBy: adminId })
      .onConflictDoNothing();
    await db.insert(userPreferences).values({ userId: adminId }).onConflictDoNothing();
    await db
      .insert(notifications)
      .values({
        id: uuid(),
        userId: adminId,
        type: "system",
        title: "Admin control plane ready",
        body: "Provision accounts, groups and invitations from the console. All actions are written to the immutable audit log.",
        status: "sent",
        sentAt: new Date(),
      })
      .onConflictDoNothing();
  }

  await upsertSettings(adminId);

  // Demo provisioning runs when the platform has no accounts other than the
  // bootstrap super admin. It is driven by the presence of the demo accounts
  // themselves (not by a marker row) so a partially seeded database heals.
  const existingDemo = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, DEMO_USERS.map((demo) => demo.email)))
    .limit(1);
  const userCount = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const alreadySeeded = existingDemo.length > 0;
  // Sandbox/demo builds seed a realistic cohort through the admin provisioning
  // path. Real deployments set SEED_DEMO_DATA=false and provision by hand.
  const demoDataEnabled = process.env.SEED_DEMO_DATA !== "false";
  const totalUsers = Number(userCount[0]?.count ?? 0);

  if (!alreadySeeded && demoDataEnabled && totalUsers <= 12) {
    for (const demo of DEMO_USERS) {
      const id = uuid();
      const role = SYSTEM_ROLES.find((r) => r.userType === demo.userType) ?? SYSTEM_ROLES[7];
      const inserted = await db
        .insert(users)
        .values({
          id,
          email: demo.email,
          passwordHash: hashPassword(DEMO_PASSWORD),
          firstName: demo.firstName,
          lastName: demo.lastName,
          preferredName: demo.firstName,
          userType: demo.userType,
          status: demo.status,
          department: demo.department,
          gradeClass: demo.gradeClass,
          program: demo.program,
          studentId: demo.studentId,
          employeeId: demo.employeeId,
          createdByAdminId: adminId,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      const userId = inserted[0]?.id;
      if (!userId) continue;
      await db.insert(userRoles).values({ userId, roleId: role.id, assignedBy: adminId }).onConflictDoNothing();
      await db.insert(userPreferences).values({ userId }).onConflictDoNothing();
    }

    const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
    const byEmail = new Map(allUsers.map((u) => [u.email, u.id]));

    for (const group of DEMO_GROUPS) {
      const groupId = uuid();
      const inserted = await db
        .insert(groups)
        .values({
          id: groupId,
          name: group.name,
          description: group.description,
          groupType: group.groupType,
          status: group.status,
          visibility: "private",
          createdByAdminId: adminId,
          retentionPolicyDays: group.groupType === "advisory" ? null : 365,
        })
        .returning({ id: groups.id });
      const createdGroupId = inserted[0]?.id;
      if (!createdGroupId) continue;
      for (const email of group.members) {
        const memberId = byEmail.get(email);
        if (!memberId) continue;
        await db
          .insert(groupMembers)
          .values({
            groupId: createdGroupId,
            userId: memberId,
            memberRole: email.startsWith("marcus") ? "admin" : "member",
            addedBy: adminId,
          })
          .onConflictDoNothing();
      }
    }

    const alinaId = byEmail.get("alina.rahman@globebridge.edu");
    const exchangeGroup = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.name, "Global Exchange 2026"))
      .limit(1);

    const directConversationId = uuid();
    if (alinaId) {
      await db.insert(conversations).values({
        id: directConversationId,
        type: "direct",
        createdBy: adminId,
        title: null,
      });
      await db
        .insert(conversationMembers)
        .values([
          { conversationId: directConversationId, userId: adminId, role: "owner" },
          { conversationId: directConversationId, userId: alinaId, role: "participant" },
        ])
        .onConflictDoNothing();

      await db.insert(messages).values({
        id: uuid(),
        conversationId: directConversationId,
        senderId: adminId,
        senderDeviceId: "system",
        clientMessageId: uuid(),
        contentType: "system",
        ciphertext: "",
        ciphertextIv: "",
        systemText: SYSTEM_TEXT_CREATED,
        status: "sent",
      });

      await db.insert(reports).values({
        id: uuid(),
        reporterId: alinaId,
        targetType: "conversation",
        targetId: directConversationId,
        reason: "Harassment or bullying",
        description: "Voluntary report from a provisioned account (sandbox sample).",
        submittedContent: "Sample reporter-supplied excerpt so moderators can see the review workflow.",
        status: "pending",
      });
    }

    const groupId = exchangeGroup[0]?.id;
    if (groupId) {
      const groupConversationId = uuid();
      await db.insert(conversations).values({
        id: groupConversationId,
        type: "group",
        groupId,
        title: "Global Exchange 2026",
        createdBy: adminId,
        lastMessageAt: new Date(),
      });
      const members = await db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId));
      await db
        .insert(conversationMembers)
        .values([
          { conversationId: groupConversationId, userId: adminId, role: "owner" },
          ...members.map((m) => ({
            conversationId: groupConversationId,
            userId: m.userId,
            role: "participant",
          })),
        ])
        .onConflictDoNothing();
      await db.insert(messages).values({
        id: uuid(),
        conversationId: groupConversationId,
        senderId: adminId,
        senderDeviceId: "system",
        clientMessageId: uuid(),
        contentType: "system",
        ciphertext: "",
        ciphertextIv: "",
        systemText: "Group channel provisioned for cohort messaging. End-to-end encryption is enabled for all members.",
        status: "sent",
      });
    }

    await db
      .insert(platformSettings)
      .values({ key: "bootstrap.version", value: BOOTSTRAP_VERSION, description: "Sandbox seed marker.", updatedBy: adminId })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: BOOTSTRAP_VERSION, updatedAt: new Date() } });
  }

  void and;

  return {
    bootstrapped: !alreadySeeded,
    adminEmail,
    demoAccounts: DEMO_ACCOUNTS,
  };
}

/** Convenience for admin pickers: active admin ids. */
export async function adminUserIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(inArray(userRoles.roleId, ["role-super-admin", "role-admin"]));
  return rows.map((r) => r.id);
}
