/** GET/POST /api/notifications — in-app notification inbox. */
import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { listNotifications, unreadNotificationCount } from "@/lib/data";
import { ApiError, enumValue, jsonOk, readJson, route, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, meta) => {
  const session = await requireUser();
  const [items, unread] = await Promise.all([
    listNotifications(session.id),
    unreadNotificationCount(session.id),
  ]);
  return jsonOk({ notifications: items, unreadCount: unread }, meta);
});

export const POST = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  const body = await readJson(req);
  const action = enumValue(body, "action", ["read", "read_all"] as const, { required: true })!;

  if (action === "read") {
    const id = str(body, "id", { required: true, max: 64 })!;
    const updated = await db
      .update(notifications)
      .set({ readAt: new Date(), status: "read" })
      .where(and(eq(notifications.id, id), eq(notifications.userId, session.id)))
      .returning({ id: notifications.id });
    if (updated.length === 0) throw new ApiError("NOTIFICATION_NOT_FOUND", "Notification not found.", 404);
  } else {
    await db
      .update(notifications)
      .set({ readAt: new Date(), status: "read" })
      .where(and(eq(notifications.userId, session.id), isNull(notifications.readAt)));
  }

  const unread = await unreadNotificationCount(session.id);
  return jsonOk({ ok: true, unreadCount: unread }, meta);
});
