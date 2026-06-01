/**
 * Cloudflare Worker — mints short-lived TURN credentials for Scrum Poker.
 *
 * Why a Worker at all? Cloudflare's `generate-ice-servers` API requires a
 * long-lived API token. Shipping that token in a public OSS client bundle
 * would let anyone drain the project's free quota. The Worker keeps the
 * token in Cloudflare-side secrets and only ever returns short-lived (4 h)
 * relay credentials suitable for embedding in `iceServers`.
 *
 * Deploy:
 *   wrangler secret put TURN_KEY_ID
 *   wrangler secret put TURN_KEY_API_TOKEN
 *   wrangler deploy
 *
 * Then set the deployed URL as `VITE_TURN_CF_TOKEN_URL` in the Scrum Poker
 * build environment.
 */

interface Env {
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
}

const TTL_SECONDS = 14400; // 4 h — longer than any realistic Scrum Poker session.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405);
    }
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      return json({ error: 'worker_misconfigured' }, 500);
    }

    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      }
    );

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return json({ error: 'upstream_failed', status: upstream.status, body: text }, 502);
    }

    const data = (await upstream.json()) as { iceServers?: unknown };
    if (!data.iceServers) {
      return json({ error: 'upstream_missing_iceServers' }, 502);
    }

    return json({ iceServers: data.iceServers, ttl: TTL_SECONDS }, 200);
  },
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
