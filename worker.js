/*
  Cloudflare Worker entry point.
  Static pages and assets are served straight from the assets store (free, unlimited).
  Only /api/* runs this code, which hands lead form posts to functions/api/lead.js.
  The same lead.js file also works on Cloudflare Pages, so either setup is supported.
*/
import { onRequestPost } from './functions/api/lead.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lead') {
      if (request.method === 'POST') {
        return onRequestPost({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
      }
      return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
        status: 405, headers: { 'Content-Type': 'application/json' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
