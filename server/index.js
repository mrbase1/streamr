'use strict';

const fastify = require('fastify')({ logger: true, trustProxy: true });
const path = require('path');

// ── PLUGINS ───────────────────────────────────────────────────────────────────
fastify.register(require('@fastify/cors'), {
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'OPTIONS'],
});

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, '../public'),
  prefix: '/',
});

fastify.register(require('@fastify/reply-from'), {
  undici: {
    connections: 128,
    pipelining: 1,
    keepAliveTimeout: 30_000,
  },
});

// ── RATE LIMITING (optional but recommended) ──────────────────────────────────
fastify.register(require('@fastify/rate-limit'), {
  max: 200,
  timeWindow: '1 minute',
});

// ── ROUTES ────────────────────────────────────────────────────────────────────
fastify.register(require('./routes/playlist'), { prefix: '/api' });
fastify.register(require('./routes/stream'), { prefix: '/api' });

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
fastify.get('/api/health', async () => ({ status: 'ok', ts: Date.now() }));

// ── START ─────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    console.log(`\n🚀 STREAMR server running at http://${host}:${port}\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
