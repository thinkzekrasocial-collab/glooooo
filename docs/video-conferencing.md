# GlobeBridge video conferencing

## Architecture and security

GlobeBridge remains authoritative for session authentication, group
membership, role/policy checks, meeting metadata and audit events. Jitsi is a
separate self-hosted media layer for WebRTC audio, video and screen sharing.
No audio, video, SDP, packets or recordings are stored in D1/PostgreSQL.
There is no public registration and no Jitsi user directory.

The server creates an opaque `gbp-...` room and signs a ten-minute HS256 JWT
restricted to that exact room. `JITSI_APP_SECRET` is server-only. The JWT
contains the GlobeBridge user identity and disables recording/livestreaming.

## Database and API

Migration `0005_video_conferencing.sql` adds explicit group call policies,
`video_meetings`, and `video_meeting_participants`, plus indexes and a partial
unique index allowing one active meeting per group. The Next API is:

- `POST /api/video-meetings` — authorized creation or existing-active reuse
- `GET /api/video-meetings?groupId=...` — authorized active-call lookup
- `GET /api/video-meetings/:id` — authorized safe metadata
- `POST /api/video-meetings/:id?action=join|leave|end` — state transitions and token issuance
- `GET /api/video-meetings/health` — safe external API reachability probe

Every request authenticates from the existing session cookie, derives identity
from the session, validates input, checks group membership/policy, rate-limits,
and records metadata-only audit events. Removed members fail new joins/tokens;
an already-connected Jitsi browser cannot be forcibly disconnected by D1 alone,
so administrators should end the meeting when access must stop immediately.

## Frontend

The group-channel header exposes Voice call and Video call only for group
channels. It creates/reuses the active meeting, then opens
`/app/groups/:groupId/video-call/:meetingId`. The route authorizes before
loading the Jitsi IFrame API from `${JITSI_BASE_URL}/external_api.js`, cleans
up the iframe/listeners on unmount, supports voice-only mode, and removes the
screen-share control when group policy disables it. Recording is never shown.

For local Next development set `NEXT_PUBLIC_API_BASE_URL=` so requests use the
Next server's same-origin routes, configure a developer-controlled Jitsi host,
and apply the migration with the project's normal Drizzle/PostgreSQL flow.
For the Cloudflare Worker deployment, port the same service contract to D1 and
Web Crypto signing before enabling the feature; do not run Jitsi containers in
Workers. The current Worker demo has a different simplified schema and is not
safe to receive these routes without that migration/adapter.

## CSP and Permissions Policy

At the application edge, allow only the configured Jitsi origin in `script-src`,
`frame-src`, `connect-src` (including `wss:`), and `media-src`; allow
`camera`/`microphone` only for the Jitsi origin/context. Never use `*` as a
global CSP workaround. The exact header belongs in the deployment layer that
terminates GlobeBridge HTTPS.

## Operations

Check `/api/video-meetings/health`, the Jitsi external API, and the four
containers (web, Prosody, Jicofo, JVB). Monitor JWT failures, database errors,
CPU, RAM, UDP reachability, bandwidth, concurrent rooms and participants. A
single JVB is intended for limited concurrency; evaluate multiple JVB nodes,
load balancing and region placement before scaling.

## Production checklist

- Apply migration 0005 and verify its constraints/indexes.
- Configure server-only Jitsi secrets; scan source/bundles for secrets.
- Set real DNS, HTTPS and firewall ports 80/443/UDP 10000.
- Configure JWT on the official Jitsi release with `JWT_ALLOW_EMPTY=0`.
- Confirm `external_api.js` and a real authorized room join.
- Confirm group removal blocks new tokens and admin end updates D1/UI.
- Keep recording/livestreaming disabled and do not deploy recording services.
- Configure CSP/Permissions Policy for the exact Jitsi domain.
- Back up application DB/config and follow Jitsi release upgrade notes.
