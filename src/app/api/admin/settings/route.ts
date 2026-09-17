/** GET/PUT /api/admin/settings — platform policy switches (super admin only writes). */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformSettings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { getSettings } from "@/lib/data";
import { ApiError, jsonOk, readJson, route } from "@/lib/http";
import { PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const WRITABLE_PREFIXES = ["registration.", "messaging.", "security.", "notifications."];

export const GET = route(async (_req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.usersView);
  return jsonOk({ settings: await getSettings() }, meta);
});

export const PUT = route(async (req: NextRequest, meta) => {
  const admin = await requirePermission(PERMISSIONS.settingsManage);
  const body = await readJson(req);
  const updates = body.settings;

  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new ApiError("VALIDATION_REQUIRED", "settings must be an object of key/value pairs.", 422);
  }

  const entries = Object.entries(updates as Record<string, unknown>);
  if (entries.length === 0) throw new ApiError("VALIDATION_NO_CHANGES", "No settings were provided.", 422);

  for (const [key] of entries) {
    if (!WRITABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new ApiError("VALIDATION_FORBIDDEN_SETTING", `${key} is not writable from this surface.`, 422);
    }
    if (key === "registration.public_signup_enabled") {
      const value = (updates as Record<string, unknown>)[key];
      if (value === true) {
        throw new ApiError(
          "POLICY_PUBLIC_SIGNUP_FORBIDDEN",
          "Public self-registration must remain disabled: accounts are provisioned by administrators or invitations.",
          422,
        );
      }
    }
  }

  for (const [key, value] of entries) {
    await db
      .insert(platformSettings)
      .values({ key, value: value as object, updatedBy: admin.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: value as object, updatedBy: admin.id, updatedAt: new Date() },
      });
  }

  await recordAudit({
    eventType: "admin.settings.updated",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "update",
    targetType: "setting",
    targetId: entries.map(([key]) => key).join(","),
    details: { keys: entries.map(([key]) => key) },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  void eq;
  return jsonOk({ ok: true, settings: await getSettings() }, meta);
});
