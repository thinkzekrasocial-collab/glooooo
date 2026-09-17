/** GET/PATCH /api/admin/reports — abuse report triage (reporter-supplied excerpts only). */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { notifyUser, recordAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { listReports } from "@/lib/data";
import { ApiError, enumValue, jsonOk, readJson, route, str } from "@/lib/http";
import { PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.reportsView);
  const url = new URL(req.url);
  const rows = await listReports(url.searchParams.get("status") ?? "all");
  return jsonOk({ reports: rows }, meta);
});

export const PATCH = route(async (req: NextRequest, meta) => {
  const admin = await requirePermission(PERMISSIONS.reportsResolve);
  const body = await readJson(req);
  const id = str(body, "id", { required: true, max: 64 })!;
  const status = enumValue(body, "status", ["under_review", "resolved", "dismissed"] as const, {
    required: true,
  })!;
  const resolutionNotes = str(body, "resolutionNotes", { max: 2000 });

  const rows = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
  const report = rows[0];
  if (!report) throw new ApiError("REPORT_NOT_FOUND", "Report not found.", 404);

  await db
    .update(reports)
    .set({
      status,
      resolutionNotes: resolutionNotes ?? report.resolutionNotes,
      assignedTo: admin.id,
      resolvedAt: status === "resolved" || status === "dismissed" ? new Date() : null,
    })
    .where(eq(reports.id, id));

  await notifyUser({
    userId: report.reporterId,
    type: "system",
    title: `Report ${status.replace("_", " ")}`,
    body: resolutionNotes ?? "A moderator reviewed the report you submitted.",
    data: { deepLink: "/app/settings" },
  });

  await recordAudit({
    eventType: "admin.report.updated",
    actorId: admin.id,
    actorRole: admin.roles.join(","),
    action: "update",
    targetType: "report",
    targetId: id,
    details: { status, hasNotes: Boolean(resolutionNotes) },
    ipAddress: meta.ip,
    correlationId: meta.requestId,
  });

  return jsonOk({ ok: true, status }, meta);
});
