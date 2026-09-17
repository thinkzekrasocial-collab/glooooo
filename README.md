# GlobeBridge Pathways — Private Encrypted Messenger

Implementation of the TRD (v3.0) as a working fullstack web application: an
administrator-provisioned, end-to-end encrypted messenger with **no public
registration anywhere in the product**, a full admin control plane, and a
metadata-only audit/security trail.

The sandbox target is Next.js (App Router) + PostgreSQL/Drizzle; the production
target in the TRD is Cloudflare Workers + D1 + Durable Objects + R2 + KV +
Queues. Every function maps 1:1 — see “Architecture mapping” below.

---

## 1. What works end to end

| Area | Status |
| --- | --- |
| Provisioned sign-in (`/login`) with lockout, security events, MFA gate | ✅ |
| TOTP MFA enrolment/verification (RFC 6238, encrypted secret at rest) | ✅ |
| Zero public registration (no route, no bundle surface, DB constraint, locked policy) | ✅ |
| Admin console: accounts, roles, groups, invitations, reports, audit, security, policy | ✅ |
| Token-gated onboarding (`/invite/:token`, hashed, single-use, expiring, admin-bound) | ✅ |
| Encrypted channels, self-healing key distribution, ciphertext-only message storage | ✅ |
| Message states sending → sent → delivered → read, typing, presence, unread counts | ✅ |
| Encrypted attachments (client-side AES-256-GCM, per-conversation key) | ✅ |
| Client-side E2EE (ECDH-P256 identity keys, HKDF, AES-256-GCM per message) | ✅ |
| Notifications inbox, self-service settings, sessions/devices, reports history | ✅ |
| Installable PWA + service worker (offline shell, push handler, no API caching) | ✅ |
| Health/readiness probe with invariant checks (`/api/health`) | ✅ |
| API smoke suite (`node scripts/smoke.mjs`) — 40+ assertions, all green | ✅ |

## 2. The fundamental rule (no public self-registration)

Enforced at five independent layers, exactly as specified in TRD §1.3:

1. **Router** — no `/register`, `/signup` or `/create-account` route exists. `POST /api/auth/register` returns 404.
2. **Service layer** — the only `INSERT INTO users` paths are `POST /api/admin/users`, invitation acceptance, and the bootstrap seeder. All require an authenticated admin context.
3. **Database** — `users.created_by_admin_id` is `NOT NULL` (no default, no null), so a user row cannot exist without an administrator reference.
4. **Client bundle** — the SPA ships no registration component or route; `/login` explicitly tells users that accounts are provisioned.
5. **Policy lock** — `registration.public_signup_enabled` is seeded `false` and the settings API rejects any attempt to enable it (`422 POLICY_PUBLIC_SIGNUP_FORBIDDEN`).

## 3. Encryption model (trust boundaries)

* Identity keys: ECDH **P-256**, generated with Web Crypto as a **non-extractable** `CryptoKey`, stored as a structured-clone key in IndexedDB. The private key is never exported or transmitted.
* Conversation keys: random 256-bit AES-GCM keys. A copy is wrapped per member device using `ECDH → HKDF-SHA256 → AES-256-GCM`; only wrapped blobs (`conversation_key_wraps`) leave the device.
* Messages: `AES-256-GCM` with a fresh 96-bit IV per message; the server stores `ciphertext` + `ciphertextIv` in base64 and never receives plaintext.
* Attachments: encrypted with the same conversation key before upload; the download endpoint returns ciphertext that only conversation members can decrypt.
* Self-healing distribution: a new browser registers a device key, reports as “awaiting key”, and any device holding the key automatically grants it (audited as `encryption.keys_distributed`).
* Server/admin limits: metadata (participants, timestamps, delivery/read state, policy), audit events, and only voluntarily submitted report excerpts. No ciphertext decryption, ever.

## 4. Architecture mapping (TRD → this sandbox)

| TRD (Cloudflare) | This implementation |
| --- | --- |
| Cloudflare Workers + Hono router | Next.js App Router route handlers under `src/app/api/**` |
| Cloudflare D1 (SQLite) | PostgreSQL via Drizzle ORM (`src/db/schema.ts`, same tables/columns) |
| Durable Objects (`ConversationRoom`, `UserActor`) | Poll-safe REST contract (`/messages`, `/state`) + `typing_indicators` table for presence/typing |
| KV (sessions, rate limits, config) | `sessions` table (hashed opaque tokens), in-process sliding-window limiter, `platform_settings` |
| Queues (notifications, files, audit) | Synchronous service layer (`src/lib/audit.ts`) with the same event contracts |
| R2 (encrypted blobs) | `attachments.stored_payload` (base64 ciphertext) behind the same access rules |
| Web Push (VAPID) + Cron triggers | Service worker push handler, `PwaRegister`, notification inbox (dispatch hooks in place) |
| argon2id (WASM) JWT RS256 | `scrypt(N=16384,r=8,p=1)` password hashing, opaque httpOnly session cookie (12h, server-revocable), AES-256-GCM sealed TOTP secrets |
| libsignal (X3DH + Double Ratchet) | Web Crypto ECDH-P256 + HKDF + AES-256-GCM with the same wire contract (ciphertext, IV, per-device wrapped keys) |

## 5. Key files

| Path | Purpose |
| --- | --- |
| `src/db/schema.ts` | 22 tables: users, roles, groups, conversations, messages, recipients, attachments, devices, keys, sessions, invitations, audit, security, reports, settings, blocks, prefs, typing |
| `src/lib/auth.ts` | Session issuance/validation, MFA gate, `requireUser` / `requirePermission`, mass revocation |
| `src/lib/rbac.ts` | 9 system roles × 22 permissions, wildcard support |
| `src/lib/crypto.ts` | Password hashing/verification, token hashing, AES-256-GCM secret sealing, TOTP, temp passwords |
| `src/lib/e2ee.ts` | Browser E2EE: identity keys, key wrapping, message/file crypto (IndexedDB backed) |
| `src/lib/data.ts` | Shared read layer used by both RSC pages and route handlers |
| `src/lib/seed.ts` | Idempotent bootstrap: roles, policy, super admin, demo cohort (through the admin path) |
| `src/components/messenger/Messenger.tsx` | Conversation list, decryption, composer, receipts, attachments, reports, key self-healing |
| `src/components/admin/AdminConsole.tsx` | 8-panel admin control plane |
| `scripts/smoke.mjs` | End-to-end API assertions (run against a local server) |

## 6. Running it

### Live Cloudflare messenger

The runnable Cloudflare Worker is in [`cloudflare/worker.js`](cloudflare/worker.js).
It uses the existing `demoo` Worker and `demooo` D1 database configured in
[`cloudflare/wrangler.jsonc`](cloudflare/wrangler.jsonc). The remote migration
creates the account, session, message, and audit tables. The live app is:

`https://demoo.shihab309kye.workers.dev`

For local Worker development, authenticate Wrangler and run:

```bash
npm run dev:cloudflare
```

The Worker is a browser-safe API base URL. It exposes `/health`, the compatible
auth routes `/api/auth/login` and `/api/auth/logout`, user `/api/users/me`,
conversation routes `/api/conversations` and
`/api/conversations/{id}/messages`, plus the simple `/api/signup`, `/api/login`,
and `/api/messages` aliases. CORS and bearer-token authentication are enabled
for frontend integration. Passwords are stored as PBKDF2 hashes; message
bodies are stored as ciphertext fields in D1.

To connect this frontend to the deployed Worker, set this public build
variable before starting or building Next.js:

```bash
NEXT_PUBLIC_API_BASE_URL=https://demoo.shihab309kye.workers.dev npm run dev
```

Cloudflare test accounts provisioned in D1:

| Account | Password | Role |
| --- | --- | --- |
| `admin@globebridge.edu` | `Admin#2026!` | administrator |
| `marcus.lee@globebridge.edu` | `User#2026!` | member |
| `alina.rahman@globebridge.edu` | `User#2026!` | member |

### Full Next.js sandbox

```bash
npx drizzle-kit push        # apply the schema
npm run build && npm run start
```

First request bootstraps roles, policy keys and the super admin. Seeded sandbox
accounts (all with password `GlobeBridge#2026!`, configurable via
`ADMIN_BOOTSTRAP_PASSWORD`; demo seeding disabled with `SEED_DEMO_DATA=false`):

| Account | Role | Why it matters |
| --- | --- | --- |
| `admin@globebridge.edu` | super admin | Full console: provisioning, policy, invitations, audit |
| `marcus.lee@globebridge.edu` | teacher | Directory + reports visibility, cannot delete accounts |
| `alina.rahman@globebridge.edu` | student | Messaging only, no administrative surface |
| `priya.nair@globebridge.edu` | counselor | Caseload visibility, group membership management |
| `jonas.weber@globebridge.edu` | staff | Directory visibility |
| `sofia.alvarez@globebridge.edu` | mentor | Messaging only |
| `dev.patel@globebridge.edu` | student (pending) | Demonstrates admin-driven activation |

Smoke test:

```bash
PORT=3100 npm run start &
SMOKE_BASE=http://127.0.0.1:3100 node scripts/smoke.mjs
```

## 7. Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection (already provisioned) |
| `ENCRYPTION_MASTER_KEY`, `ENCRYPTION_MASTER_SALT` | Optional key material for sealing TOTP/secret fields at rest |
| `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` | Bootstrap super admin + seeded sandbox password |
| `SEED_DEMO_DATA=false` | Disable the demo cohort in a real deployment |
