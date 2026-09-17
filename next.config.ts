import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async headers() {
    const jitsi = (process.env.JITSI_BASE_URL?.trim() || "https://meet.example.com").replace(/\/$/, "");
    const api = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: `frame-src 'self' ${jitsi}; script-src 'self' ${jitsi}; connect-src 'self' ${jitsi} wss://${new URL(jitsi).hostname}${api ? ` ${api}` : ""}; media-src 'self' blob: ${jitsi}` },
        { key: "Permissions-Policy", value: `camera=(self "${jitsi}"), microphone=(self "${jitsi}"), display-capture=(self "${jitsi}")` },
      ],
    }];
  },
};

export default nextConfig;
