import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent production navigations from receiving partial Flight streams.
  // A closed partial stream is surfaced by React as error #412 instead of
  // falling back to a full document navigation.
  cacheComponents: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    const jitsi = (process.env.JITSI_BASE_URL?.trim() || "https://meet.example.com").replace(/\/$/, "");
    const api = (
      process.env.NEXT_PUBLIC_CLOUDFLARE_API_BASE_URL ??
      process.env.NEXT_PUBLIC_API_BASE_URL ??
      "https://demoo.shihab309kye.workers.dev"
    ).replace(/\/$/, "");
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; frame-src 'self' ${jitsi}; script-src 'self' 'unsafe-inline' ${jitsi}; connect-src 'self' ${jitsi} wss://${new URL(jitsi).hostname}${api ? ` ${api}` : ""}; media-src 'self' blob: ${jitsi}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'` },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "Permissions-Policy", value: `camera=(self "${jitsi}"), microphone=(self "${jitsi}"), display-capture=(self "${jitsi}")` },
      ],
    }];
  },
};

export default nextConfig;
