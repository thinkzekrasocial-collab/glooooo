/** PATCH/DELETE /api/messages/:id — edit or soft-delete a ciphertext message. */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { isConversationMember } from "@/lib/data";
import { ApiError, jsonOk, readJson, route, str } from "@/lib/http";
import { hasPermission, PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const EDIT_WINDOW_MS = 15 * 60 * 1000;

export const PATCH = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;

  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  const message = rows[0];
  if (!message) throw new ApiError("MESSAGE_NOT_FOUND", "Message not found.", 404);
  if (message.senderId !== session.id) {
    throw new ApiError("AUTH_FORBIDDEN", "Only the author can edit this message.", 403);
  }
  if (!(await isConversationMember(session.id, message.conversationId))) {
    throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
  }
  if (message.deletedAt) throw new ApiError("MESSAGE_DELETED", "This message was deleted.", 409);
  if (message.contentType !== "text") {
    throw new ApiError("MESSAGE_NOT_EDITABLE", "Only text messages can be edited.", 409);
  }
  if (Date.now() - message.serverTimestamp.getTime() > EDIT_WINDOW_MS) {
    throw new ApiError("MESSAGE_EDIT_WINDOW_CLOSED", "The 15 minute edit window has closed.", 409);
  }

  const body = await readJson(req);
  const ciphertext = str(body, "ciphertext", { required: true, max: 1_400_000, label: "Ciphertext" })!;
  const ciphertextIv = str(body, "ciphertextIv", { required: true, max: 64, label: "Initialisation vector" })!;

  await db
    .update(messages)
    .set({ ciphertext, ciphertextIv, editedAt: new Date() })
    .where(eq(messages.id, id));

  await recordAudit({
    eventType: "message.edited",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "update",
    targetType: "message",
    targetId: id,
    details: { conversationId: message.conversationId },
    ipAddress: meta.ip,
    deviceId: session.deviceId,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, editedAt: new Date().toISOString() }, meta);
});

export const DELETE = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;

  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  const message = rows[0];
  if (!message) throw new ApiError("MESSAGE_NOT_FOUND", "Message not found.", 404);

  const isAuthor = message.senderId === session.id;
  const canModerate = hasPermission(session.permissions, PERMISSIONS.conversationsAudit) ||
    hasPermission(session.permissions, PERMISSIONS.reportsResolve);
  if (!isAuthor && !canModerate) {
    throw new ApiError("AUTH_FORBIDDEN", "You cannot delete this message.", 403);
  }

  await db
    .update(messages)
    .set({
      deletedAt: new Date(),
      deletedBy: session.id,
      status: "deleted",
      ciphertext: "",
      ciphertextIv: "",
      systemText: "This message was deleted.",
    })
    .where(eq(messages.id, id));

  await recordAudit({
    eventType: "message.deleted",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "delete",
    targetType: "message",
    targetId: id,
    details: { conversationId: message.conversationId, asAuthor: isAuthor },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true }, meta);
});
