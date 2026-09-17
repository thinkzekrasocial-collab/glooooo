/** GET /api/attachments/:id — encrypted payload for conversation members only. */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, messages } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { isConversationMember } from "@/lib/data";
import { ApiError, jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;

  const rows = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  const attachment = rows[0];
  if (!attachment) throw new ApiError("ATTACHMENT_NOT_FOUND", "Attachment not found.", 404);
  if (!attachment.storedPayload) {
    throw new ApiError("ATTACHMENT_UNAVAILABLE", "This attachment payload is no longer retained.", 410);
  }

  if (attachment.messageId) {
    const messageRows = await db.select().from(messages).where(eq(messages.id, attachment.messageId)).limit(1);
    const message = messageRows[0];
    if (!message) throw new ApiError("ATTACHMENT_NOT_FOUND", "Attachment not found.", 404);
    if (!(await isConversationMember(session.id, message.conversationId))) {
      throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
    }
  } else if (attachment.uploaderId !== session.id) {
    throw new ApiError("AUTH_FORBIDDEN", "You cannot access this attachment.", 403);
  }

  return jsonOk(
    {
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSizeBytes: attachment.fileSizeBytes,
      scanStatus: attachment.scanStatus,
      /** AES-256-GCM ciphertext with the 12-byte IV prefixed — never plaintext. */
      storedPayload: attachment.storedPayload,
    },
    meta,
  );
});
