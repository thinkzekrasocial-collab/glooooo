"use client";

import { useEffect } from "react";

/** Registers the service worker so the messenger is installable and push-capable. */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    const timer = window.setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* offline support is best-effort */
      });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
