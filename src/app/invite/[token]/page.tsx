import { AcceptInviteForm } from "@/components/auth/AcceptInviteForm";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 px-6 py-14">
      <header className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" className="h-11 w-11 rounded-xl" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--color-glow-400)]">
            GlobeBridge Pathways
          </p>
          <h1 className="text-lg font-semibold text-white">Activate your account</h1>
        </div>
      </header>
      <AcceptInviteForm token={token} />
    </main>
  );
}
