import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import {
  listReportsForUser,
  listUserDevices,
  listUserSessions,
  myGroups,
  userPreferencesFor,
} from "@/lib/data";
import { SettingsConsole } from "@/components/settings/SettingsConsole";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  const rows = await db.select().from(users).where(eq(users.id, session.id)).limit(1);
  const user = rows[0];
  if (!user) redirect("/login");

  const [preferences, sessions, devices, groups, reports] = await Promise.all([
    userPreferencesFor(user.id),
    listUserSessions(user.id),
    listUserDevices(user.id),
    myGroups(user.id),
    listReportsForUser(user.id),
  ]);

  return (
    <SettingsConsole
      me={{
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        preferredName: user.preferredName,
        phoneNumber: user.phoneNumber,
        campusLocation: user.campusLocation,
        dateOfBirth: user.dateOfBirth,
        userType: user.userType,
        status: user.status,
        studentId: user.studentId,
        employeeId: user.employeeId,
        department: user.department,
        gradeClass: user.gradeClass,
        program: user.program,
        mfaEnabled: user.mfaEnabled,
        mfaRequired: user.mfaRequired,
        roles: session.roles,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      }}
      initial={{
        preferences: {
          notifications: (preferences.notificationSettings ?? {}) as Record<string, boolean>,
          privacy: (preferences.privacySettings ?? {}) as Record<string, boolean>,
          theme: preferences.theme,
        },
        sessions: sessions.map((row) => ({
          id: row.id,
          current: row.id === session.sessionId,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          createdAt: row.createdAt,
          lastUsedAt: row.lastUsedAt,
          expiresAt: row.expiresAt,
        })),
        devices: devices.map((row) => ({
          id: row.id,
          current: row.id === session.deviceId,
          deviceName: row.deviceName,
          browserInfo: row.browserInfo,
          status: row.status,
          lastActiveAt: row.lastActiveAt,
        })),
        groups,
        reports,
      }}
    />
  );
}
