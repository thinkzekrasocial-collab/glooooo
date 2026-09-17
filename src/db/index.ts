import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

// Next analyzes route modules during `next build`, before runtime secrets are
// available. Never fail at module evaluation: that would make Vercel unable to
// collect route data. The placeholder is deliberately unreachable; production
// requests must provide DATABASE_URL and will fail at the database operation
// boundary instead of breaking deployment-time route analysis.
const connectionString = databaseUrl ?? "postgresql://build-only.invalid/globebridge";

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
