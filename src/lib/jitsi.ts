import { createHmac } from "node:crypto";
import { ApiError } from "@/lib/http";

function base64Url(value: string | Uint8Array): string {
  const encoded = typeof value === "string" ? Buffer.from(value).toString("base64") : Buffer.from(value).toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ApiError("JITSI_NOT_CONFIGURED", "Video conferencing is not configured.", 503);
  return value;
}

export function jitsiBaseUrl(): string {
  return required("JITSI_BASE_URL").replace(/\/$/, "");
}

export type JitsiTokenInput = {
  roomName: string;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl?: string | null;
  allowScreenSharing: boolean;
};

export function issueJitsiToken(input: JitsiTokenInput): { token: string; expiresAt: Date } {
  const secret = required("JITSI_APP_SECRET");
  const appId = required("JITSI_APP_ID");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + 10 * 60) * 1000);
  const payload = {
    aud: process.env.JITSI_JWT_AUDIENCE?.trim() || appId,
    iss: process.env.JITSI_JWT_ISSUER?.trim() || appId,
    sub: process.env.JITSI_JWT_SUBJECT?.trim() || new URL(jitsiBaseUrl()).hostname,
    room: input.roomName,
    iat: now,
    exp: now + 10 * 60,
    context: {
      user: {
        id: input.userId,
        name: input.displayName,
        email: input.email,
        ...(input.avatarUrl ? { avatar: input.avatarUrl } : {}),
      },
      features: {
        recording: false,
        livestreaming: false,
        ...(input.allowScreenSharing ? { "screen-sharing": true } : {}),
      },
    },
  };
  const header = { alg: "HS256", typ: "JWT" };
  const encoded = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(encoded).digest();
  return { token: `${encoded}.${base64Url(signature)}`, expiresAt };
}
