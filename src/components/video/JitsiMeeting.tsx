"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (domain: string, options: Record<string, unknown>) => { dispose: () => void; addListener: (event: string, handler: (payload?: unknown) => void) => void; executeCommand: (command: string, ...args: unknown[]) => void };
  }
}

export function JitsiMeeting({ domain, roomName, jwt, displayName, email, meetingType, allowScreenSharing, onLeave }: { domain: string; roomName: string; jwt: string; displayName: string; email: string; meetingType: string; allowScreenSharing: boolean; onLeave: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<InstanceType<NonNullable<typeof window.JitsiMeetExternalAPI>> | null>(null);
  const [state, setState] = useState("Loading conference…");
  useEffect(() => {
    let disposed = false;
    const script = document.createElement("script");
    script.src = `${domain.replace(/\/$/, "")}/external_api.js`;
    script.async = true;
    script.onload = () => {
      if (disposed || !containerRef.current || !window.JitsiMeetExternalAPI) return setState("Video conference service is currently unavailable.");
      const toolbar = ["microphone", "camera", ...(allowScreenSharing ? ["desktop"] : []), "hangup", "chat", "participants-pane", "settings"];
      const api = new window.JitsiMeetExternalAPI(new URL(domain).hostname, { roomName, jwt, parentNode: containerRef.current, userInfo: { displayName, email }, configOverwrite: { prejoinConfig: { enabled: true }, disableAP: true, disableAPButtons: true, recording: { enabled: false }, toolbarButtons: toolbar }, interfaceConfigOverwrite: { TOOLBAR_BUTTONS: toolbar }, defaultLanguage: "en" });
      apiRef.current = api;
      api.addListener("videoConferenceJoined", () => setState("Connected"));
      api.addListener("connectionEstablished", () => setState("Connected"));
      api.addListener("connectionFailed", () => setState("Connection lost — retrying…"));
      api.addListener("readyToClose", onLeave);
      if (meetingType === "voice") api.executeCommand("toggleVideo");
      if (!allowScreenSharing) setState("Connected · screen sharing disabled by group policy");
    };
    script.onerror = () => setState("Video conference service is currently unavailable.");
    document.head.appendChild(script);
    return () => { disposed = true; apiRef.current?.dispose(); apiRef.current = null; script.remove(); };
  }, [allowScreenSharing, displayName, domain, email, meetingType, onLeave, roomName, jwt]);
  return <div className="flex min-h-[70vh] flex-1 flex-col bg-black"><div className="border-b border-white/10 px-4 py-2 text-xs text-slate-400">{state}</div><div ref={containerRef} className="min-h-0 flex-1" /></div>;
}
