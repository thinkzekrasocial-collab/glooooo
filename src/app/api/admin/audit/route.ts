/** GET /api/admin/audit — immutable audit trail (metadata only, never plaintext). */
import { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listAuditLogsPage } from "@/lib/data";
import { jsonOk, route } from "@/lib/http";
import { PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.auditView);
  const url = new URL(req.url);
  const logs = await listAuditLogsPage({
    eventType: url.searchParams.get("eventType") ?? undefined,
    actorId: url.searchParams.get("actorId") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
  });
  return jsonOk({ logs }, meta);
});
