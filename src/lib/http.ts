/**
 * HTTP layer: stable error envelope (TRD §5.2), request metadata, validation
 * helpers and an in-process sliding-window rate limiter (TRD §24 — Cloudflare
 * KV/Rate Limiting binding stand-in for this sandbox runtime).
 */
import { NextRequest } from "next/server";
import { randomToken } from "@/lib/crypto";

export class ApiError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type RequestMeta = {
  ip: string;
  userAgent: string;
  requestId: string;
  origin: string | null;
};

export function getRequestMeta(req: NextRequest, requestId?: string): RequestMeta {
  const forwarded = req.headers.get("x-forwarded-for");
  return {
    ip: (forwarded ? forwarded.split(",")[0] : req.headers.get("x-real-ip")) ?? "127.0.0.1",
    userAgent: req.headers.get("user-agent") ?? "unknown",
    requestId: requestId ?? randomToken(8),
    origin: req.headers.get("origin"),
  };
}

function assertSameOrigin(req: NextRequest): void {
  if (process.env.NODE_ENV === "production") {
    const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
    if ((forwardedProto ?? new URL(req.url).protocol.replace(":", "")) !== "https") {
      throw new ApiError("HTTPS_REQUIRED", "HTTPS is required.", 400);
    }
  }
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.get("origin");
  if (origin) {
    const allowed = [new URL(req.url).origin, process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "")].filter(Boolean);
    if (!allowed.includes(origin.replace(/\/$/, ""))) throw new ApiError("CSRF_ORIGIN_REJECTED", "Cross-site request rejected.", 403);
  } else if (req.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("CSRF_ORIGIN_REJECTED", "Cross-site request rejected.", 403);
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId,
          timestamp: new Date().toISOString(),
        },
      },
      { status: error.status, headers: { "X-Request-Id": requestId } },
    );
  }
  console.error(`[${requestId}] unhandled error`, error);
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong. Please try again.",
        details: {},
        requestId,
        timestamp: new Date().toISOString(),
      },
    },
    { status: 500, headers: { "X-Request-Id": requestId } },
  );
}

/** Wraps a route handler with request-id propagation and error envelope. */
export function route<T extends unknown[]>(
  handler: (req: NextRequest, meta: RequestMeta, ...rest: T) => Promise<Response>,
) {
  return async (req: NextRequest, ...rest: T): Promise<Response> => {
    const meta = getRequestMeta(req);
    try {
      assertSameOrigin(req);
      return await handler(req, meta, ...rest);
    } catch (error) {
      return errorResponse(error, meta.requestId);
    }
  };
}

export function jsonOk(data: unknown, meta: RequestMeta, status = 200): Response {
  return Response.json(data as Record<string, unknown>, {
    status,
    headers: {
      "X-Request-Id": meta.requestId,
      "Cache-Control": "no-store",
    },
  });
}

/* ─────────────────────────── validation ─────────────────────────── */

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (text.length > 1_500_000) {
      throw new ApiError("VALIDATION_PAYLOAD_TOO_LARGE", "Request payload is too large.", 413);
    }
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ApiError("VALIDATION_INVALID_JSON", "Request body must be a JSON object.", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("VALIDATION_INVALID_JSON", "Request body must be valid JSON.", 400);
  }
}

export function str(
  body: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; min?: number; max?: number; label?: string } = {},
): string | undefined {
  const raw = body[key];
  const label = opts.label ?? key;
  if (raw === undefined || raw === null || raw === "") {
    if (opts.required) throw new ApiError("VALIDATION_REQUIRED", `${label} is required.`, 422);
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ApiError("VALIDATION_TYPE", `${label} must be text.`, 422);
  }
  const value = raw.trim();
  if (opts.min && value.length < opts.min) {
    throw new ApiError("VALIDATION_MIN_LENGTH", `${label} must be at least ${opts.min} characters.`, 422);
  }
  if (opts.max && value.length > opts.max) {
    throw new ApiError("VALIDATION_MAX_LENGTH", `${label} must be at most ${opts.max} characters.`, 422);
  }
  return value;
}

export function enumValue<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  opts: { required?: boolean } = {},
): T | undefined {
  const value = str(body, key, { required: opts.required });
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new ApiError("VALIDATION_ENUM", `${key} must be one of: ${allowed.join(", ")}.`, 422);
  }
  return value as T;
}

export function boolValue(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ApiError("VALIDATION_TYPE", `${key} must be a boolean.`, 422);
}

export function intValue(
  body: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new ApiError("VALIDATION_TYPE", `${key} must be an integer.`, 422);
  }
  if (opts.min !== undefined && num < opts.min) {
    throw new ApiError("VALIDATION_RANGE", `${key} must be >= ${opts.min}.`, 422);
  }
  if (opts.max !== undefined && num > opts.max) {
    throw new ApiError("VALIDATION_RANGE", `${key} must be <= ${opts.max}.`, 422);
  }
  return num;
}

export function stringArray(
  body: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; maxItems?: number } = {},
): string[] | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (opts.required) throw new ApiError("VALIDATION_REQUIRED", `${key} is required.`, 422);
    return undefined;
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new ApiError("VALIDATION_TYPE", `${key} must be an array of ids.`, 422);
  }
  const values = (raw as string[]).map((v) => v.trim()).filter(Boolean);
  if (opts.maxItems && values.length > opts.maxItems) {
    throw new ApiError("VALIDATION_RANGE", `Too many items in ${key}.`, 422);
  }
  return values;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function parseCursor(value: string | null): string | null {
  if (!value) return null;
  return value;
}

export function clampLimit(value: string | null, fallback = 50, max = 200): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/* ─────────────────────────── rate limiting ─────────────────────────── */

type Bucket = { hits: number[]; };
const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
};

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      resetAt: bucket.hits[0] + windowMs,
      limit,
    };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);

  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.hits.every((t) => now - t > windowMs)) buckets.delete(k);
    }
  }

  return {
    allowed: true,
    remaining: limit - bucket.hits.length,
    resetAt: now + windowMs,
    limit,
  };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt / 1000)),
  };
}

export function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const result = rateLimit(key, limit, windowMs);
  if (!result.allowed) {
    throw new ApiError("RATE_LIMIT_EXCEEDED", "Too many requests. Please slow down.", 429, {
      retryAfterMs: result.resetAt - Date.now(),
    });
  }
  return result;
}
