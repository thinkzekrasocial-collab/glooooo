/** Tiny typed fetch wrapper for client components (matches the TRD error envelope). */

export class ApiClientError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type Options = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};

// Compatibility for the Worker bearer-token session. Keep the token scoped to
// this browser tab so a route transition or reload can restore the session
// without exposing it to unrelated tabs or persisting it beyond the tab.
let legacyBearerToken: string | null = null;
const SESSION_TOKEN_KEY = "gb_session_token";

export function setLegacyBearerToken(token: string | null): void {
  legacyBearerToken = token;
  if (typeof window === "undefined") return;
  try {
    if (token) window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Private browsing or restricted storage can fail; in-memory auth still works.
  }
}

function getBearerToken(): string | null {
  if (legacyBearerToken) return legacyBearerToken;
  if (typeof window === "undefined") return null;
  try {
    legacyBearerToken = window.sessionStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    legacyBearerToken = null;
  }
  return legacyBearerToken;
}

export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  // Use the configured Worker directly. Its CORS allow-list includes the
  // production frontend origin, and the bearer token is persisted per tab so
  // the session survives the redirect to `/app`. Without an external Worker,
  // keep the app's same-origin API behavior.
  const apiBase = apiBaseUrl();
  const bearerToken = getBearerToken();
  const requestPath = apiBase ? `${apiBase}${path}` : path;
  const response = await fetch(requestPath, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    credentials: apiBase ? "include" : "same-origin",
    cache: "no-store",
  });

  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new ApiClientError("INVALID_RESPONSE", "The server returned an invalid response.", response.status);
    }
  }

  if (!response.ok) {
    const envelope = payload as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> } | string;
    };
    const errorObject = typeof envelope.error === "string" ? { message: envelope.error } : envelope.error;
    throw new ApiClientError(
      errorObject?.code ?? "REQUEST_FAILED",
      errorObject?.message ?? "The request could not be completed.",
      response.status,
      errorObject?.details ?? {},
    );
  }

  return payload as T;
}

/** Resolve the API origin used by browser-only service calls. */
export function apiBaseUrl(): string {
  // NEXT_PUBLIC_* values are inlined into the browser bundle at build time,
  // including production builds. Ignoring this value in production sends the
  // login request to the frontend host instead of the configured Worker API.
  const configuredBase =
    process.env.NEXT_PUBLIC_CLOUDFLARE_API_BASE_URL?.trim() || process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  return configuredBase ? configuredBase.replace(/\/$/, "") : "";
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatClock(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
