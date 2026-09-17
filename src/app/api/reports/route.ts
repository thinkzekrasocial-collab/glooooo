/**
 * GET/POST /api/reports — user-submitted abuse reports.
 * Reviewers only ever see the excerpt the reporter chose to submit (TRD §17).
 */
import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { recordAudit, recordSecurityEvent } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { uuid } from "@/lib/crypto";
import { isConversationMember } from "@/lib/data";
import {
  ApiError,
  enforceRateLimit,
  enumValue,
  jsonOk,
  readJson,
  route,
  str,
} from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, meta) => {
  const session = await requireUser();
  const rows = await db
    .select()
    .from(reports)
    .where(eq(reports.reporterId, session.id))
    .orderBy(desc(reports.createdAt))
    .limit(25);
  return jsonOk(
    {
      reports: rows.map((row) => ({
        id: row.id,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        status: row.status,
        resolutionNotes: row.resolutionNotes,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      })),
    },
    meta,
  );
});

export const POST = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  enforceRateLimit(`report:${session.id}`, 10, 60 * 60_000);

  const body = await readJson(req);
  const targetType = enumValue(body, "targetType", ["message", "user", "conversation"] as const, {
    required: true,
  })!;
  const targetId = str(body, "targetId", { required: true, max: 64, label: "Target" })!;
  const reason = str(body, "reason", { required: true, max: 120, label: "Reason" })!;
  const description = str(body, "description", { max: 2000 });
  const submittedContent = str(body, "submittedContent", { max: 4000 });

  if (targetType === "conversation" && !(await isConversationMember(session.id, targetId))) {
    throw new ApiError("AUTH_FORBIDDEN", "You can only report your own conversations.", 403);
  }

  const reportId = uuid();
  await db.insert(reports).values({
    id: reportId,
    reporterId: session.id,
    targetType,
    targetId,
    reason,
    description: description ?? null,
    submittedContent: submittedContent ?? null,
    status: "pending",
  });

  await recordAudit({
    eventType: "report.created",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "create",
    targetType,
    targetId,
    details: { reason, hasExcerpt: Boolean(submittedContent) },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });
  await recordSecurityEvent({
    userId: session.id,
    eventType: "abuse_report_submitted",
    severity: "warning",
    ipAddress: meta.ip,
    details: { reportId, targetType, reason },
  });

  return jsonOk({ reportId, status: "pending" }, meta, 201);
});
