# Self-hosted Jitsi Meet

GlobeBridge uses the official `docker-jitsi-meet` deployment with JWT token
authentication. This directory contains the project-specific configuration
contract; download the matching official release package rather than cloning
the development repository. The current upstream Docker guide is the source
of truth for image versions and generated service configuration:
<https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/>.

## Prerequisites

Use a Linux VM with Docker Engine and the Compose plugin, a real DNS name such
as `meet.globebridge.example`, a publicly trusted TLS certificate, and enough
CPU/RAM/network capacity for the expected concurrent participants. Create an
A/AAAA record for the host. Do not put Jitsi media behind a Cloudflare Worker
or HTTP proxy; UDP/10000 must reach the JVB directly.

Download an official release, copy its `env.example` and `docker-compose.yml`,
then apply the values in this directory's `.env.example`. Run the upstream
`gen-passwords.sh` helper and replace every `replace_me` value. Set:

```text
PUBLIC_URL=https://meet.globebridge.example
ENABLE_AUTH=1
AUTH_TYPE=jwt
JWT_ALLOW_EMPTY=0
JWT_APP_ID=<same as GlobeBridge JITSI_APP_ID>
JWT_APP_SECRET=<same as GlobeBridge JITSI_APP_SECRET>
```

Do not use secure-domain/internal authentication for this integration. The
official documentation marks secure-domain as deprecated and recommends JWT.
Do not enable Jigasi, recording, livestreaming, or cloud recording. Keep
`recording.enabled=false` in the custom web configuration and do not add a
recording service.

## DNS, TLS and firewall

Expose TCP 80/443 for HTTP/TLS and UDP 10000 for JVB media. Redirect HTTP to
HTTPS, use a valid certificate, and verify that `https://<domain>/external_api.js`
is reachable from the GlobeBridge browser. If users sit behind restrictive
networks, add a separately operated self-hosted TURN service and document its
credentials; do not place TURN secrets in GlobeBridge.

## Start and verify

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 web prosody jicofo jvb
curl -fsS https://meet.globebridge.example/external_api.js >/dev/null
```

The official stack generates its config volumes on first start. Verify web,
Prosody, Jicofo and JVB health before connecting the application.

## GlobeBridge secrets

Put `JITSI_BASE_URL`, `JITSI_APP_ID`, `JITSI_APP_SECRET`, issuer, audience and
subject in Worker/server secrets (or the Next server environment), never in a
`NEXT_PUBLIC_*` variable, HTML, localStorage, audit logs, or chat messages.
The application issues short-lived room-scoped tokens; Jitsi does not become a
second GlobeBridge user directory.

## Upgrades and backups

Read the upstream release notes, back up the Jitsi config directory and `.env`
using your secret-management process, pull the new official release, and run
`docker compose up -d`. Back up GlobeBridge D1/PostgreSQL and migration files
separately. Recording is disabled, so there are no media recordings to back
up. Monitor container health, CPU, RAM, bandwidth, room count, and JWT errors.
