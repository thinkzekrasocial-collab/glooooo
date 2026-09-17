/**
 * GET /api/directory — people the caller may start a channel with.
 * Privileged roles see the full active directory; everyone else only sees peers
 * they already share a group or channel with.
 */
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { getDirectory } from "@/lib/data";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  const url = new URL(req.url);
  const people = await getDirectory(session, url.searchParams.get("q") ?? undefined);
  return jsonOk({ people }, meta);
});
