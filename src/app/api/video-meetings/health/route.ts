import { NextRequest } from "next/server";
import { jitsiBaseUrl } from "@/lib/jitsi";
import { jsonOk, route } from "@/lib/http";

export const GET = route(async (_req: NextRequest, meta) => {
  const domain = jitsiBaseUrl();
  try {
    const response = await fetch(`${domain}/external_api.js`, { method: "HEAD", signal: AbortSignal.timeout(5000), cache: "no-store" });
    return jsonOk({ ok: response.ok, service: "video-conferencing", jitsi: response.ok ? "reachable" : "unavailable" }, meta);
  } catch {
    return Response.json({ ok: false, service: "video-conferencing", jitsi: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store", "X-Request-Id": meta.requestId } });
  }
});
