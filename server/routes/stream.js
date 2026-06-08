'use strict';

const { URL }    = require('url');
const { fetch, pipeline } = require('undici');
const { Readable } = require('stream');

// Tiny segment cache for .ts files (reduces repeated origin hits for same viewers)
const segCache = new Map();
const SEG_TTL  = 8_000; // 8 seconds — just enough to serve multiple clients the same seg

function getSegCached(key) {
  const e = segCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { segCache.delete(key); return null; }
  return e.buf;
}
function setSegCached(key, buf) {
  // Only cache small segments (<= 2 MB) to avoid memory bloat
  if (buf.length > 2 * 1024 * 1024) return;
  segCache.set(key, { buf, expires: Date.now() + SEG_TTL });
  if (segCache.size > 100) {
    segCache.delete(segCache.keys().next().value);
  }
}

// Headers we pass from the origin response to the browser
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'last-modified',
  'etag',
];

// Headers we must NOT forward upstream (would confuse the origin)
const BLOCKED_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'te', 'trailers',
  'transfer-encoding', 'upgrade', 'proxy-authorization',
]);

module.exports = async function streamRoutes(fastify) {

  const querySchema = {
    querystring: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 10 },
      },
    },
  };

  /**
   * GET /api/stream?url=<stream-url>
   *
   * Handles three content types:
   *   1. HLS master manifest (.m3u8 with #EXT-X-STREAM-INF) — rewrite variant URLs
   *   2. HLS media manifest (.m3u8 with #EXTINF segments)   — rewrite segment URLs
   *   3. Raw .ts / .aac / .mp4 segment                      — pipe bytes directly
   */
  fastify.get('/stream', { schema: querySchema }, async (request, reply) => {
    const { url } = request.query;

    // Validate
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return reply.code(400).send({ error: 'Only http/https URLs allowed' });
      }
    } catch {
      return reply.code(400).send({ error: 'Invalid URL' });
    }

    // Derive proxy base from request
    const isLocalhost = request.hostname === 'localhost' || request.hostname === '127.0.0.1';
    const portSuffix  = (request.port && !['80','443'].includes(request.port))
                        ? `:${request.port}` : '';
    const proxyBase   = `${request.protocol}://${request.hostname}${isLocalhost ? portSuffix : ''}`;

    // Check segment cache
    const isSegment = /\.(ts|aac|mp4|m4s|fmp4)(\?|$)/i.test(url);
    if (isSegment) {
      const cached = getSegCached(url);
      if (cached) {
        reply.header('Content-Type', 'video/mp2t');
        reply.header('X-Cache', 'HIT');
        return reply.send(cached);
      }
    }

    // Build upstream request headers (forward relevant ones from browser)
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (compatible; StreamrProxy/1.0)',
      'Accept':     '*/*',
    };
    for (const [k, v] of Object.entries(request.headers)) {
      if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) {
        upstreamHeaders[k] = v;
      }
    }

    // Fetch from origin
    let res;
    try {
      res = await fetch(url, {
        headers: upstreamHeaders,
        signal:  AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
    } catch (err) {
      fastify.log.warn({ err, url }, 'Stream fetch failed');
      return reply.code(502).send({ error: 'Failed to reach stream origin', detail: err.message });
    }

    if (!res.ok) {
      return reply.code(res.status).send({ error: `Origin returned ${res.status}` });
    }

    const contentType = res.headers.get('content-type') || '';

    // ── HLS MANIFEST (.m3u8) ──────────────────────────────────────────────────
    if (
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl') ||
      url.includes('.m3u8') ||
      url.includes('.m3u')
    ) {
      const text = await res.text();

      // Rewrite all URLs inside the manifest to proxy through us
      const rewritten = rewriteManifest(text, url, proxyBase);

      reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cache-Control', 'no-cache');
      return reply.send(rewritten);
    }

    // ── BINARY SEGMENT (ts / mp4 / etc.) ────────────────────────────────────
    // Stream the body directly to the client
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cache-Control', 'public, max-age=10');

    for (const h of PASSTHROUGH_HEADERS) {
      const val = res.headers.get(h);
      if (val) reply.header(h, val);
    }

    if (isSegment) {
      // Buffer small segments for the cache, then send
      const buf = Buffer.from(await res.arrayBuffer());
      setSegCached(url, buf);
      reply.header('X-Cache', 'MISS');
      return reply.send(buf);
    }

    // Large / unknown — pipe directly without buffering
    const nodeStream = Readable.fromWeb(res.body);
    return reply.send(nodeStream);
  });
};

// ── MANIFEST REWRITER ─────────────────────────────────────────────────────────
function rewriteManifest(text, baseUrl, proxyBase) {
  const lines = text.split('\n');
  const out   = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) { out.push(''); continue; }

    // Comment/tag lines: pass through, but check URI= attributes
    if (line.startsWith('#')) {
      // Rewrite URI="..." inside tags like #EXT-X-KEY, #EXT-X-MAP
      const rewritten = line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = resolveUrl(uri, baseUrl);
        return `URI="${proxyBase}/api/stream?url=${encodeURIComponent(abs)}"`;
      });
      out.push(rewritten);
      continue;
    }

    // URL line — rewrite it
    const abs = resolveUrl(line, baseUrl);
    if (abs.startsWith('http')) {
      out.push(`${proxyBase}/api/stream?url=${encodeURIComponent(abs)}`);
    } else {
      out.push(line); // passthrough if we can't resolve
    }
  }

  return out.join('\n');
}

function resolveUrl(url, base) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try { return new URL(url, base).href; } catch { return url; }
}
