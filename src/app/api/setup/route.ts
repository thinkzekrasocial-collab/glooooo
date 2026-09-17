/**
 * POST /api/setup — idempotent bootstrap (system roles, platform settings, super admin).
 * GET  /api/setup — public readiness probe used by the login screen.
 *
 * There is deliberately NO /register, /signup or /create-account route in this
 * application (TRD §1.3 layer 1). Accounts only come into existence through the
 * admin control plane or an admin-issued invitation.
 */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformSettings } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { enforceRateLimit, jsonOk, route } from "@/lib/http";
import { DEMO_ACCOUNTS, ensureBootstrap } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const POST = route(async (_req: NextRequest, meta) => {
  enforceRateLimit(`setup:${meta.ip}`, 5, 60_000);
  const result = await ensureBootstrap();
  return jsonOk({ ok: true, ...result }, meta);
});

export const GET = route(async (_req: NextRequest, meta) => {
  const rows = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, "registration.public_signup_enabled"))
    .limit(1);

  const session = await getSessionUser();

  return jsonOk(
    {
      ready: true,
      publicSignupEnabled: Boolean(rows[0]?.value ?? false),
      authenticated: Boolean(session),
      /** Sandbox convenience only: production deployments never publish credentials. */
      sandboxAccounts: DEMO_ACCOUNTS,
    },
    meta,
  );
});
