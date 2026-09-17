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

export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://demoo.shihab309kye.workers.dev").replace(/\/$/, "");
  const token = typeof window !== "undefined" ? window.localStorage.getItem("gb_token") : null;
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    credentials: apiBase ? "omit" : "same-origin",
    cache: "no-store",
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

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
