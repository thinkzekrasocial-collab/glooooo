/** GET /api/admin/overview — console dashboard metrics (metadata only). */
import { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { adminOverview } from "@/lib/data";
import { jsonOk, route } from "@/lib/http";
import { PERMISSIONS } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, meta) => {
  await requirePermission(PERMISSIONS.usersView);
  const overview = await adminOverview();
  return jsonOk(overview, meta);
});
