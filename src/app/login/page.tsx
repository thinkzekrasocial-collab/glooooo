import { LoginForm } from "@/components/auth/LoginForm";

// Production never ships usernames or passwords in the client bundle.
const CLOUDFLARE_ACCOUNTS: never[] = [];

export default function LoginPage() {
  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-6xl flex-col items-center justify-center gap-10 px-6 py-14 lg:flex-row lg:items-stretch lg:gap-16">
      <section className="w-full max-w-md lg:pt-6">
        <div className="mb-8 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-11 w-11 rounded-xl" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--color-glow-400)]">
              GlobeBridge Pathways
            </p>
            <h1 className="text-lg font-semibold text-white">Private Encrypted Messenger</h1>
          </div>
        </div>

        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[color:var(--color-mint-400)]/20 bg-[color:var(--color-mint-400)]/10 px-3 py-1 text-xs font-medium text-[color:var(--color-mint-400)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-mint-400)] shadow-[0_0_12px_var(--color-mint-400)]" />
          Secure workspace online
        </div>
        <h2 className="text-4xl font-semibold leading-[1.08] tracking-[-0.04em] text-white sm:text-5xl">
          Sign in to your provisioned account
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Accounts are created by GlobeBridge administrators only. Invitations are issued in person
          and expire automatically — there is no public sign-up form anywhere in this application.
        </p>

        <LoginForm sandboxAccounts={CLOUDFLARE_ACCOUNTS} sandboxPassword="" />
      </section>

      <section className="w-full max-w-md space-y-4 lg:pt-6">
        <div className="panel p-5">
          <h3 className="text-sm font-semibold text-white">How this deployment protects you</h3>
          <ul className="mt-3 space-y-3 text-sm text-slate-400">
            <li className="flex gap-3">
              <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-mint-400)]" />
              <span>
                <strong className="text-slate-200">End-to-end encrypted.</strong> Message bodies are
                AES-256-GCM ciphertext created in your browser. The server stores and routes
                ciphertext it cannot read.
              </span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-mint-400)]" />
              <span>
                <strong className="text-slate-200">Device-bound keys.</strong> Your identity key is a
                non-extractable Web Crypto key that never leaves this browser profile.
              </span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-mint-400)]" />
              <span>
                <strong className="text-slate-200">No public registration.</strong> Every account
                references the administrator who created it, and every action is written to an
                immutable audit trail.
              </span>
            </li>
          </ul>
        </div>

        <div className="panel p-5">
          <h3 className="text-sm font-semibold text-white">Trust boundaries</h3>
          <div className="mt-3 grid gap-2 text-xs text-slate-400">
            <p>
              <span className="chip-info">Trusted</span> Your browser: plaintext, private keys,
              decryption.
            </p>
            <p>
              <span className="chip-warn">Semi-trusted</span> Server &amp; administrators: metadata,
              routing, policy, moderation of voluntarily submitted excerpts.
            </p>
            <p>
              <span className="chip-danger">Untrusted</span> Database &amp; object storage: ciphertext
              blobs only.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
