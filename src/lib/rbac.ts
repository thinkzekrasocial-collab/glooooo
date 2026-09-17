/** Role-Based Access Control — TRD §6 / §9. */

export const PERMISSIONS = {
  usersView: "users.view",
  usersCreate: "users.create",
  usersUpdate: "users.update",
  usersSuspend: "users.suspend",
  usersDelete: "users.delete",
  usersResetPassword: "users.reset_password",
  usersManageRoles: "users.manage_roles",
  usersManageGroups: "users.manage_groups",
  usersViewSecurity: "users.view_security",
  groupsView: "groups.view",
  groupsCreate: "groups.create",
  groupsUpdate: "groups.update",
  groupsDelete: "groups.delete",
  groupsManageMembers: "groups.manage_members",
  auditView: "audit.view",
  securityView: "security.view",
  reportsView: "reports.view",
  reportsResolve: "reports.resolve",
  settingsManage: "settings.manage",
  invitationsManage: "invitations.manage",
  conversationsAudit: "conversations.audit",
  devicesManage: "devices.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

export type SystemRole = {
  id: string;
  name: string;
  description: string;
  userType: string;
  permissions: Permission[] | ["*"];
};

/** System roles are part of the codebase and can never be deleted (TRD §4.2 roles.is_system). */
export const SYSTEM_ROLES: SystemRole[] = [
  {
    id: "role-super-admin",
    name: "super_admin",
    description: "Platform owner. Full control including destructive operations.",
    userType: "admin",
    permissions: ["*"],
  },
  {
    id: "role-admin",
    name: "admin",
    description: "School administrator: manages users, groups, invitations, audit.",
    userType: "admin",
    permissions: ALL_PERMISSIONS.filter(
      (p) => p !== PERMISSIONS.usersDelete && p !== PERMISSIONS.settingsManage,
    ),
  },
  {
    id: "role-moderator",
    name: "moderator",
    description: "Safety moderator: reviews reports and read-only user/group visibility.",
    userType: "staff",
    permissions: [
      PERMISSIONS.usersView,
      PERMISSIONS.groupsView,
      PERMISSIONS.reportsView,
      PERMISSIONS.reportsResolve,
      PERMISSIONS.auditView,
      PERMISSIONS.securityView,
    ],
  },
  {
    id: "role-counselor",
    name: "counselor",
    description: "Counselor: visibility across caseloads for safeguarding.",
    userType: "counselor",
    permissions: [
      PERMISSIONS.usersView,
      PERMISSIONS.groupsView,
      PERMISSIONS.groupsManageMembers,
      PERMISSIONS.reportsView,
    ],
  },
  {
    id: "role-teacher",
    name: "teacher",
    description: "Teacher: sees directory and their class groups only.",
    userType: "teacher",
    permissions: [PERMISSIONS.usersView, PERMISSIONS.groupsView],
  },
  {
    id: "role-staff",
    name: "staff",
    description: "Non-teaching staff directory access.",
    userType: "staff",
    permissions: [PERMISSIONS.usersView, PERMISSIONS.groupsView],
  },
  {
    id: "role-mentor",
    name: "mentor",
    description: "Program mentor / host family.",
    userType: "mentor",
    permissions: [],
  },
  {
    id: "role-student",
    name: "student",
    description: "Messaging only. No administrative surface at all.",
    userType: "student",
    permissions: [],
  },
  {
    id: "role-parent",
    name: "parent",
    description: "Guardian messaging only.",
    userType: "parent",
    permissions: [],
  },
];

export function roleIdForUserType(userType: string): string {
  const match = SYSTEM_ROLES.find((r) => r.userType === userType);
  return match?.id ?? "role-student";
}

export function hasPermission(permissions: string[], permission: Permission): boolean {
  return permissions.includes("*") || permissions.includes(permission);
}

export function hasAnyAdminSurface(permissions: string[]): boolean {
  return (
    hasPermission(permissions, PERMISSIONS.usersView) ||
    hasPermission(permissions, PERMISSIONS.auditView) ||
    hasPermission(permissions, PERMISSIONS.groupsView)
  );
}

export const USER_TYPES = [
  "student",
  "teacher",
  "staff",
  "mentor",
  "counselor",
  "parent",
  "admin",
] as const;
export type UserType = (typeof USER_TYPES)[number];

export const USER_STATUSES = ["pending", "active", "suspended", "deactivated", "deleted"] as const;

export const GROUP_TYPES = ["class", "department", "program", "advisory", "custom"] as const;
export const GROUP_STATUSES = ["draft", "active", "archived", "deleted"] as const;
