import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PwaRegister } from "@/components/PwaRegister";
import "./globals.css";

export const metadata: Metadata = {
  title: "GlobeBridge Pathways · Private Messenger",
  description:
    "Administrator-provisioned, end-to-end encrypted messaging for GlobeBridge Pathways. Web-only, installable, zero public registration.",
  manifest: "/manifest.webmanifest",
  applicationName: "GlobeBridge Messenger",
  appleWebApp: { capable: true, title: "GlobeBridge", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#05070f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <script src="/sw-recovery.js" />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[color:var(--color-glow-500)] focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
