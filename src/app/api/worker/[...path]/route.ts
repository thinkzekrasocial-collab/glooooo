import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const workerBase = () =>
  (
    process.env.NEXT_PUBLIC_CLOUDFLARE_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
    "https://demoo.shihab309kye.workers.dev"
  ).replace(/\/$/, "");

const SESSION_COOKIE = "gb_session_token";

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const upstreamUrl = `${workerBase()}/${path.join("/")}${new URL(request.url).search}`;
  const headers = new Headers();
  const authorizationHeader = request.headers.get("authorization");
  const cookieToken = request.cookies.get(SESSION_COOKIE)?.value;
  const authorization = authorizationHeader || (cookieToken ? `Bearer ${decodeURIComponent(cookieToken)}` : null);
  const contentType = request.headers.get("content-type");
  if (authorization) headers.set("authorization", authorization);
  if (contentType) headers.set("content-type", contentType);

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    cache: "no-store",
  });

  const responseBody = await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  const responseType = upstream.headers.get("content-type");
  if (responseType) responseHeaders.set("content-type", responseType);
  if (path.join("/") === "api/auth/login" && upstream.ok) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(responseBody)) as { token?: string };
      if (payload.token) {
        responseHeaders.append(
          "set-cookie",
          `${SESSION_COOKIE}=${encodeURIComponent(payload.token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`,
        );
      }
    } catch {
      // Preserve the upstream response if it is not the expected login envelope.
    }
  } else if (path.join("/") === "api/auth/logout") {
    responseHeaders.append("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  }
  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;
