/** GET/PUT /api/users/me/preferences — notification & privacy preferences. */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { userPreferencesFor } from "@/lib/data";
import { ApiError, jsonOk, readJson, route } from "@/lib/http";

export const dynamic = "force-dynamic";

const NOTIFICATION_KEYS = [
  "directMessages",
  "groupMessages",
  "mentions",
  "securityAlerts",
  "pushEnabled",
  "emailEnabled",
] as const;
const PRIVACY_KEYS = ["readReceipts", "typingIndicators", "onlineStatus"] as const;

export const GET = route(async (_req: NextRequest, meta) => {
  const session = await requireUser();
  const preferences = await userPreferencesFor(session.id);
  return jsonOk({ preferences }, meta);
});

export const PUT = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  const body = await readJson(req);
  const current = await userPreferencesFor(session.id);

  const notificationSettings = { ...(current.notificationSettings as Record<string, boolean>) };
  const privacySettings = { ...(current.privacySettings as Record<string, boolean>) };

  const notificationsInput = body.notifications;
  if (notificationsInput && typeof notificationsInput === "object") {
    for (const key of NOTIFICATION_KEYS) {
      const value = (notificationsInput as Record<string, unknown>)[key];
      if (typeof value === "boolean") notificationSettings[key] = value;
    }
  }
  const privacyInput = body.privacy;
  if (privacyInput && typeof privacyInput === "object") {
    for (const key of PRIVACY_KEYS) {
      const value = (privacyInput as Record<string, unknown>)[key];
      if (typeof value === "boolean") privacySettings[key] = value;
    }
  }
  const theme = typeof body.theme === "string" ? body.theme : undefined;
  if (theme && !["system", "light", "dark"].includes(theme)) {
    throw new ApiError("VALIDATION_ENUM", "theme must be system, light or dark.", 422);
  }

  await db
    .update(userPreferences)
    .set({
      notificationSettings,
      privacySettings,
      theme: theme ?? current.theme,
      updatedAt: new Date(),
    })
    .where(eq(userPreferences.userId, session.id));

  await recordAudit({
    eventType: "user.preferences.updated",
    actorId: session.id,
    action: "update",
    targetType: "user",
    targetId: session.id,
    details: { notifications: Object.keys(notificationSettings), privacy: Object.keys(privacySettings), theme },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  const preferences = await userPreferencesFor(session.id);
  return jsonOk({ preferences }, meta);
});
