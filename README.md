# STREAMR — IPTV Player

A self-hosted IPTV player with a Fastify proxy server that eliminates CORS issues,
plus a responsive PWA frontend that works on desktop, mobile, and smart TVs.

---

## Project Structure

```
streamr/
├── server/
│   ├── index.js          ← Fastify entry point
│   └── routes/
│       ├── playlist.js   ← M3U fetch + URL rewriter
│       └── stream.js     ← HLS manifest + segment proxy
├── public/
│   ├── index.html        ← PWA frontend
│   ├── manifest.json     ← PWA manifest
│   └── sw.js             ← Service worker
├── package.json
├── .env.example
└── README.md
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env if needed (default port is 3000)
```

### 3. Run the server

```bash
# Production
npm start

# Development (auto-restarts on file changes, Node 18+)
npm run dev
```

### 4. Open the player

Navigate to: **http://localhost:3000**

---

## How It Works

```
Browser → GET /api/playlist?url=<m3u-url>
        ← Returns rewritten M3U (all stream URLs → /api/stream?url=...)

Browser → GET /api/stream?url=<stream-url>
        ← Proxied HLS manifest or .ts segment with CORS headers
```

Every stream URL is rewritten to route back through your server,
so the browser never makes a cross-origin request directly.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Server health check |
| `GET /api/playlist?url=<url>` | Fetch + rewrite an M3U playlist |
| `GET /api/stream?url=<url>` | Proxy an HLS manifest or segment |

---

## Deployment

### Railway (recommended)

1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub
3. Set `PORT` environment variable if needed (Railway sets it automatically)
4. Done — Railway runs it as a persistent Node.js process

### Render

1. New Web Service → connect your repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Free tier spins down after inactivity — upgrade for always-on

### Fly.io

```bash
fly launch
fly deploy
```

### VPS (Ubuntu)

```bash
npm install -g pm2
pm2 start server/index.js --name streamr
pm2 save && pm2 startup
```

---

## Smart TV / Remote Control

The frontend supports TV remote navigation out of the box:

| Key | Action |
|---|---|
| ↑ / ↓ | Previous / next channel |
| CH+ / CH- | Previous / next channel |
| Enter / OK | Play focused channel |
| Backspace / Back | Close channel list |
| F | Toggle fullscreen |
| M | Toggle channel list |
| MediaPlayPause | Play / pause |

TV mode is auto-detected (large screen + coarse pointer / no hover).

---

## Notes

- Playlist responses are cached for 60 seconds server-side
- `.ts` segments ≤2 MB are cached for 8 seconds (reduces origin load for multiple viewers)
- Rate limiting: 200 requests/minute per IP
- Requires Node.js 18+
