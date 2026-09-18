"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { JitsiMeeting } from "@/components/video/JitsiMeeting";
import { apiFetch, ApiClientError } from "@/lib/api-client";

type JoinResponse = { meeting: { id: string; roomName: string; type: string; title: string }; group: { id: string; name: string }; conference: { domain: string; jwt: string; meetingType: string; screenSharingEnabled: boolean; displayName: string; email: string } };

export default function VideoCallPage({ params }: { params: Promise<{ groupId: string; meetingId: string }> }) {
  const router = useRouter();
  const [data, setData] = useState<JoinResponse | null>(null);
  const [error, setError] = useState("Checking conference permissions…");
  const [joining, setJoining] = useState(true);
  const leave = useCallback(async () => { if (data) await apiFetch(`/api/video-meetings/${data.meeting.id}?action=leave`, { method: "POST" }).catch(() => undefined); router.push("/app"); }, [data, router]);
  useEffect(() => { let cancelled = false; void params.then(({ meetingId }) => apiFetch<JoinResponse>(`/api/video-meetings/${meetingId}?action=join`, { method: "POST" }).then((payload) => { if (!cancelled) { setData(payload); setError(""); setJoining(false); } }).catch((caught) => { if (!cancelled) { setJoining(false); setError(caught instanceof ApiClientError ? caught.message : "Unable to authorize the conference."); } })); return () => { cancelled = true; }; }, [params]);
  if (joining) return <main className="flex min-h-[calc(100vh-57px)] items-center justify-center p-8 text-slate-300">{error}</main>;
  if (!data) return <main className="flex min-h-[calc(100vh-57px)] flex-col items-center justify-center gap-4 p-8 text-center"><p className="text-rose-200">{error}</p><button className="btn-ghost" onClick={() => router.push("/app")}>Back to messenger</button></main>;
  return <main className="flex min-h-[calc(100vh-57px)] flex-col"><header className="flex items-center gap-3 border-b border-white/10 px-4 py-3"><button className="btn-ghost" onClick={() => void leave()}>Leave</button><div><h1 className="text-sm font-semibold text-white">{data.meeting.title}</h1><p className="text-xs text-slate-500">{data.group.name}</p></div></header><JitsiMeeting domain={data.conference.domain} roomName={data.meeting.roomName} jwt={data.conference.jwt} displayName={data.conference.displayName} email={data.conference.email} meetingType={data.conference.meetingType} allowScreenSharing={data.conference.screenSharingEnabled} onLeave={leave} /></main>;
}
