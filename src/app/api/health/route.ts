/** GET /api/health — readiness probe (database + platform invariants). */
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    const result = await db.execute(sql`
      select
        (select count(*)::int from users where deleted_at is null) as users,
        (select count(*)::int from conversations where status = 'active') as conversations,
        (select count(*)::int from messages where deleted_at is null) as messages,
        (select count(*)::int from audit_logs) as audit_events
    `);
    const row = (result.rows[0] ?? {}) as Record<string, number>;

    return Response.json(
      {
        ok: true,
        service: "globebridge-messenger",
        checks: {
          database: "ok",
          noPublicRegistration: true,
          messageStorage: "ciphertext-only",
          e2ee: "AES-256-GCM (client) + ECDH-P256 key wrapping",
        },
        counts: {
          users: Number(row.users ?? 0),
          activeConversations: Number(row.conversations ?? 0),
          messages: Number(row.messages ?? 0),
          auditEvents: Number(row.audit_events ?? 0),
        },
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[health] database check failed", error);
    return Response.json(
      { ok: false, service: "globebridge-messenger", checks: { database: "error" } },
      { status: 500 },
    );
  }
}
