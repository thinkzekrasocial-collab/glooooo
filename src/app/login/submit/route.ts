import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const workerBase = () =>
  (
    process.env.NEXT_PUBLIC_CLOUDFLARE_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
    "https://demoo.shihab309kye.workers.dev"
  ).replace(/\/$/, "");

/** Native-form fallback for browsers where the login client has not hydrated. */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  if (!email || !password) {
    return NextResponse.redirect(new URL("/login?error=missing_credentials", request.url), 303);
  }

  try {
    const upstream = await fetch(`${workerBase()}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
    const payload = (await upstream.json()) as { token?: string };
    if (!upstream.ok || !payload.token) {
      return NextResponse.redirect(new URL("/login?error=invalid_credentials", request.url), 303);
    }

    const response = NextResponse.redirect(new URL("/app", request.url), 303);
    response.cookies.set("gb_session_token", payload.token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 86400,
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=service_unavailable", request.url), 303);
  }
}
