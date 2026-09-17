import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

// Next analyzes route modules during `next build`, before runtime secrets are
// available. Keep the hard failure for real requests while using a deliberately
// unreachable build-only URL so the application can be compiled.
const connectionString =
  databaseUrl ??
  (process.env.NEXT_PHASE === "phase-production-build"
    ? "postgresql://build-only.invalid/globebridge"
    : undefined);

if (!connectionString) throw new Error("DATABASE_URL is required at runtime");

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
