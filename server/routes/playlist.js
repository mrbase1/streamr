'use strict';

const { URL }  = require('url');
const { fetch } = require('undici');

// Simple in-memory cache: url → { text, expires }
const cache = new Map();
const CACHE_TTL_MS = 60_000; // 60 seconds

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.text;
}
function setCached(key, text) {
  cache.set(key, { text, expires: Date.now() + CACHE_TTL_MS });
  // Prevent unbounded growth
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

/**
 * Rewrites every stream URL inside an M3U so it routes back through
 * this proxy's /api/stream endpoint. This is what makes CORS disappear.
 */
function rewriteM3U(text, baseUrl, proxyBase) {
  const lines = text.split('\n');
  const out   = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith('#EXTM3U') || line.startsWith('#EXTINF') ||
        line.startsWith('#EXT-X-') || line.startsWith('#KODIPROP') ||
        line.startsWith('#EXTVLCOPT')) {
      out.push(lines[i]);
      continue;
    }

    // It's a URL or relative path — rewrite it
    if (line.startsWith('http://') || line.startsWith('https://')) {
      out.push(`${proxyBase}/api/stream?url=${encodeURIComponent(line)}`);
    } else if (line.startsWith('/')) {
      // Absolute path on same host
      const resolved = new URL(line, baseUrl).href;
      out.push(`${proxyBase}/api/stream?url=${encodeURIComponent(resolved)}`);
    } else if (line.length > 0) {
      // Relative path
      const resolved = new URL(line, baseUrl).href;
      out.push(`${proxyBase}/api/stream?url=${encodeURIComponent(resolved)}`);
    } else {
      out.push(lines[i]);
    }
  }

  return out.join('\n');
}

module.exports = async function playlistRoutes(fastify) {

  const querySchema = {
    querystring: {
      type: 'object',
      required: ['url'],
      properties: {
        url:   { type: 'string', minLength: 10 },
        proxy: { type: 'string' }, // optional: override proxy base URL
      },
    },
  };

  /**
   * GET /api/playlist?url=<m3u-url>&proxy=<optional-override>
   * Fetches a remote M3U playlist, rewrites stream URLs, and returns it.
   */
  fastify.get('/playlist', { schema: querySchema }, async (request, reply) => {
    const { url, proxy } = request.query;

    // Validate URL
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return reply.code(400).send({ error: 'Only http/https URLs allowed' });
      }
    } catch {
      return reply.code(400).send({ error: 'Invalid URL' });
    }

    // Derive proxy base: use explicit param, or infer from request
    const proxyBase = proxy ||
      `${request.protocol}://${request.hostname}${request.hostname.includes('localhost') || /:\d+$/.test(request.hostname) ? '' : ''}` +
      (request.port && request.port !== '80' && request.port !== '443' ? `:${request.port}` : '');

    // Check cache
    const cached = getCached(url);
    if (cached) {
      reply.header('Content-Type', 'application/x-mpegurl; charset=utf-8');
      reply.header('X-Cache', 'HIT');
      return reply.send(rewriteM3U(cached, url, proxyBase));
    }

    // Fetch from origin
    let text;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; StreamrProxy/1.0)',
          'Accept':     '*/*',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        return reply.code(502).send({ error: `Origin returned ${res.status}` });
      }

      text = await res.text();
    } catch (err) {
      fastify.log.error({ err, url }, 'Failed to fetch playlist');
      return reply.code(502).send({ error: 'Failed to fetch playlist', detail: err.message });
    }

    if (!text.trim().startsWith('#EXTM3U') && !text.includes('#EXTINF')) {
      return reply.code(422).send({ error: 'Response does not appear to be a valid M3U playlist' });
    }

    setCached(url, text);

    reply.header('Content-Type', 'application/x-mpegurl; charset=utf-8');
    reply.header('X-Cache', 'MISS');
    return reply.send(rewriteM3U(text, url, proxyBase));
  });
};
