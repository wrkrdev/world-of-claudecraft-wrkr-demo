# WRKR Scale Deploy Handoff

This runbook is for deploying the game from a clean clone on one WRKR Scale VM.
It intentionally avoids third-party app platforms: no Vercel, Supabase,
Clerk/Auth0, Pusher/Ably, Render, Railway, or managed Postgres.

## Target

- Plan: WRKR Scale
- VM resources: 4 vCPU, 8 GiB RAM, 100 GiB disk
- Runtime: one game realm on one VM
- Player cap: 25 concurrent online players
- App stack: Node.js, WebSocket, Postgres, Docker Compose, Caddy/WRKR ingress

## MacBook staging reason

The demo repo is prepared on the MacBook first because the WRKR VM may be busy
with active WRKR v2 work. The VM deployment proof should be a clean clone plus
env plus runbook, not a hand-built app depending on accidental VM state.

## VM prerequisites

The WRKR base image should already include the normal workstation/runtime tools:

- Git
- Node.js 22+
- Docker + Docker Compose, or the ability to install them
- Caddy or WRKR app ingress
- curl

Postgres runs inside this app's Compose stack, so no external database is
required.

## Clone

```bash
git clone <WRKR_GITHUB_REPO_URL> world-of-claudecraft-wrkr-demo
cd world-of-claudecraft-wrkr-demo
```

## Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
POSTGRES_PASSWORD=<long-random-password>
MAX_PLAYERS=25
EASTBROOK_MEDIA_DIR=./media-cache
```

Do not set `ALLOW_DEV_COMMANDS=1` on a public server.

## Boot

```bash
docker compose up -d --build
docker compose ps
```

The game listens on loopback only:

```text
127.0.0.1:8787
```

Expose it through Caddy or WRKR ingress, not by opening Postgres or the raw game
port publicly.

## Caddy example

Replace `game.example.com` with the selected domain:

```caddyfile
game.example.com {
	reverse_proxy 127.0.0.1:8787
	encode gzip
}
```

WebSockets work through Caddy automatically.

## Health

```bash
curl -fsS http://127.0.0.1:8787/api/status
```

Expected fields include:

- `ok`
- `realm`
- `players_online`
- `max_players`
- `peak_online`
- `uptime_seconds`
- `tick_ms_avg`
- `rss_bytes`
- `heap_used_bytes`

## Smoke

From the VM or another machine that can reach the game:

```bash
SERVER_URL=http://127.0.0.1:8787 npm run smoke:mp
SERVER_URL=http://127.0.0.1:8787 npm run smoke:ws
```

The multiplayer smoke creates real accounts and characters, opens WebSockets,
moves, chats, and verifies persistence across reconnect.

## 25-player load proof

Run against the local server before public announcement:

```bash
SERVER_URL=http://127.0.0.1:8787 npm run load:25
```

Run against the public URL after Caddy/ingress is configured:

```bash
SERVER_URL=https://game.example.com npm run load:25
```

The script should pass while `/api/status` reports `max_players: 25`.

## Operations

Logs:

```bash
docker compose logs -f game
```

Restart:

```bash
docker compose up -d --build
```

Stop:

```bash
docker compose down
```

Backup Postgres:

```bash
mkdir -p backups
docker exec eastbrook-db pg_dump -U eastbrook eastbrook | gzip > backups/eastbrook-$(date +%Y%m%d-%H%M%S).sql.gz
```

Restore Postgres:

```bash
gunzip -c backups/<backup>.sql.gz | docker exec -i eastbrook-db psql -U eastbrook eastbrook
```

Disk hygiene:

```bash
docker system df
docker image prune
```

## Production checklist

- `.env` exists and is not committed
- `POSTGRES_PASSWORD` is long and unique
- `MAX_PLAYERS=25`
- `ALLOW_DEV_COMMANDS` is unset
- `/api/status` returns healthy
- `npm run smoke:mp` passes
- `npm run smoke:ws` passes
- `npm run load:25` passes
- public URL uses HTTPS
- Postgres is not exposed publicly
- backup command has been tested
