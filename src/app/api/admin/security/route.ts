/** GET /api/admin/security — security event stream for the console. */
import { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listSecurityEventsPage } from "@/lib/data";
import { jsonOk, route } from "@/lib/http";
import { PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.securityView);
  const url = new URL(req.url);
  const events = await listSecurityEventsPage({
    severity: url.searchParams.get("severity") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
  });
  return jsonOk({ events }, meta);
});
