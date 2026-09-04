# Cloudflare Tunnel Beta (`doplo.dev`)

This mode publishes the local Docker stack without opening inbound router ports.
It is intended for a closed beta while the Windows host and Docker Desktop remain
online; it is not a replacement for the dedicated production VM.

## Cloudflare routes

Create one remotely managed tunnel and publish both hostnames to the same service:

- `doplo.dev` -> `http://tunnel-edge:80`
- `*.doplo.dev` -> `http://tunnel-edge:80`

Cloudflare creates the corresponding proxied DNS records. The internal Caddy edge
uses the preserved host header to route the dashboard to Next.js and preview or
project hostnames to the artifact gateway.

## Local setup

1. Copy `.env.example` to `.env` if it does not exist.
2. Run `node scripts/configure-tunnel-env.mjs`.
3. Store the tunnel token as `CLOUDFLARE_TUNNEL_TOKEN` in the ignored `.env` file.
4. Configure real GitHub OAuth credentials for callback URL
   `https://doplo.dev/api/auth/callback/github`.
5. Start the beta stack:

   ```bash
   docker compose -f docker-compose.yml -f deploy/docker-compose.tunnel.yml up -d --build
   ```

The override removes host port publishing for PostgreSQL, Redis, MinIO, API, web,
and the development Caddy service. Only the outbound Cloudflare Tunnel connector
can reach `tunnel-edge` on the private Compose network.
