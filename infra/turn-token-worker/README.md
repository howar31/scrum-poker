# scrum-poker-turn (Cloudflare Worker)

Mints short-lived TURN credentials for the Scrum Poker client without exposing
the Cloudflare API token in the public bundle.

## Setup

1. Create a Cloudflare Realtime TURN key in the Cloudflare dashboard. Note
   the `TURN_KEY_ID` and generate an API token with credential-generation
   scope (`TURN_KEY_API_TOKEN`).
2. Install Wrangler (`npm install -g wrangler`) and authenticate
   (`wrangler login`).
3. From this directory:

   ```sh
   wrangler secret put TURN_KEY_ID
   wrangler secret put TURN_KEY_API_TOKEN
   wrangler deploy
   ```

4. Copy the deployed URL (e.g. `https://scrum-poker-turn.<subdomain>.workers.dev`)
   and set it as `VITE_TURN_CF_TOKEN_URL` in the Scrum Poker build environment.

## Behaviour

- `GET /` (any path) → returns `{ iceServers, ttl }` with 4 h TTL.
- `OPTIONS` → CORS preflight (allows any origin).
- Any other method → 405.

The Cloudflare API token is never returned to the client. If the upstream
call fails, the Worker returns 502 — the Scrum Poker client treats that as a
soft failure and falls back to STUN + Open Relay.
