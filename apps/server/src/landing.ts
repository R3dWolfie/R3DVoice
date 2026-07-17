import type { FastifyInstance } from "fastify";

/**
 * Stop-gap landing page at GET /. Until P7 (full web client) ships, this
 * gives the URL something to render instead of the API's 404. Self-contained
 * inline HTML — no static assets, no template engine, no build step.
 */
export async function landingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(LANDING_HTML);
  });
}

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>R3DVoice — voice + screenshare for friends</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="description" content="Open-source, self-hostable voice + screenshare. End-to-end encrypted DMs. Cross-platform desktop client."/>
  <meta property="og:title" content="R3DVoice"/>
  <meta property="og:description" content="Voice + screenshare for friends, raid nights, and the people you actually want to hear."/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg: oklch(0.10 0.005 25);
      --bg-elev: oklch(0.13 0.008 22);
      --text: oklch(0.96 0.01 25);
      --text-mid: oklch(0.78 0.01 25);
      --text-dim: oklch(0.58 0.01 25);
      --text-faint: oklch(0.42 0.01 25);
      --accent: oklch(0.58 0.190 22);
      --accent-glow: oklch(0.72 0.19 22);
      --border: oklch(0.22 0.012 25);
      --border-soft: oklch(0.18 0.012 25);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "Inter Tight", system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.55;
    }
    .wrap { max-width: 880px; margin: 0 auto; padding: 96px 32px; flex: 1; }
    header {
      display: flex; align-items: center; gap: 16px;
      padding-bottom: 64px;
    }
    .title {
      font-size: clamp(2.4rem, 5vw, 3.6rem);
      font-weight: 700;
      letter-spacing: -0.02em;
      margin: 0 0 16px;
      line-height: 1.05;
    }
    .title .accent {
      background: linear-gradient(100deg, var(--accent-glow), var(--accent));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    p.lede {
      font-size: 1.2rem;
      color: var(--text-mid);
      max-width: 56ch;
      margin: 0 0 48px;
    }
    .badges { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 64px; }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 0.85rem;
      color: var(--text-mid);
      background: var(--bg-elev);
    }
    .badge .pip { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 64px;
    }
    .card {
      padding: 20px 24px;
      background: var(--bg-elev);
      border: 1px solid var(--border-soft);
      border-radius: 12px;
    }
    .card h3 {
      margin: 0 0 8px;
      font-size: 1rem;
      letter-spacing: -0.01em;
    }
    .card p {
      margin: 0;
      font-size: 0.9rem;
      color: var(--text-mid);
    }
    .cta {
      display: flex; gap: 12px; flex-wrap: wrap;
      margin: 32px 0 64px;
    }
    .btn {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 22px;
      border-radius: 10px;
      font-weight: 500;
      font-size: 0.95rem;
      text-decoration: none;
      transition: transform 80ms ease;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn.primary {
      background: linear-gradient(180deg, var(--accent-glow), var(--accent));
      color: oklch(0.18 0.04 22);
      border: 1px solid color-mix(in oklch, var(--accent) 70%, black);
      box-shadow: 0 8px 24px -8px color-mix(in oklch, var(--accent) 60%, transparent);
    }
    .btn.ghost {
      background: var(--bg-elev);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .h2 { font-size: 1.4rem; margin: 0 0 16px; letter-spacing: -0.01em; }
    code, pre, .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
    pre {
      background: var(--bg-elev);
      border: 1px solid var(--border-soft);
      border-radius: 10px;
      padding: 16px;
      overflow-x: auto;
      font-size: 0.85rem;
      color: var(--text-mid);
    }
    footer {
      border-top: 1px solid var(--border-soft);
      padding: 32px;
      text-align: center;
      color: var(--text-faint);
      font-size: 0.85rem;
    }
    a { color: var(--accent-glow); }
    a:hover { color: var(--text); }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <svg viewBox="0 0 28 28" width="56" height="56" fill="none" aria-hidden="true">
        <defs>
          <radialGradient id="bg" cx="32%" cy="22%" r="90%">
            <stop offset="0" stop-color="oklch(0.72 0.19 22)"/>
            <stop offset=".55" stop-color="oklch(0.58 0.18 22)"/>
            <stop offset="1" stop-color="oklch(0.38 0.14 22)"/>
          </radialGradient>
          <linearGradient id="r" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="oklch(0.97 0.012 25)"/>
            <stop offset="1" stop-color="oklch(0.88 0.030 25)"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="28" height="28" rx="6.4" fill="url(#bg)"/>
        <rect x="0.5" y="0.5" width="27" height="27" rx="6" fill="none" stroke="rgba(255,255,255,.10)" stroke-width=".6"/>
        <path transform="translate(0.35,0.5)" fill="rgba(0,0,0,.20)"
              d="M8.1 5.9 h8.4 a4.7 4.7 0 0 1 4.7 4.7 v.95 a4.7 4.7 0 0 1 -3.45 4.55 l4.4 6.4 h-4.05 l-3.9 -5.95 h-2.35 v5.95 h-3.75 z M11.85 9.3 v3.45 h4.4 a1.72 1.72 0 0 0 0 -3.45 z"/>
        <path fill="url(#r)"
              d="M8.1 5.9 h8.4 a4.7 4.7 0 0 1 4.7 4.7 v.95 a4.7 4.7 0 0 1 -3.45 4.55 l4.4 6.4 h-4.05 l-3.9 -5.95 h-2.35 v5.95 h-3.75 z M11.85 9.3 v3.45 h4.4 a1.72 1.72 0 0 0 0 -3.45 z"/>
        <circle cx="16.25" cy="11.05" r=".62" fill="oklch(0.58 0.18 22)"/>
      </svg>
      <span style="font-weight:700;letter-spacing:-0.01em;font-size:1.4rem;">R3DVoice</span>
    </header>

    <h1 class="title">
      Talk loud.<br/>
      <span class="accent">Share screens.</span><br/>
      Own your server.
    </h1>
    <p class="lede">
      Open-source voice + screenshare for friends, raid nights, and the people you actually want to hear.
      End-to-end encrypted DMs. Self-hostable. No telemetry.
    </p>

    <div class="badges">
      <span class="badge"><span class="pip"></span> v0.3.0 · live</span>
      <span class="badge mono">AGPL-3.0</span>
      <span class="badge mono">e2ee dms · argon2id · totp</span>
    </div>

    <div class="cta">
      <a class="btn primary" href="https://github.com/R3dWolfie/R3DVoice/releases/latest">Download desktop client →</a>
      <a class="btn ghost" href="https://github.com/R3dWolfie/R3DVoice">View on GitHub</a>
    </div>

    <h2 class="h2">What's in it</h2>
    <div class="grid">
      <div class="card">
        <h3>Voice</h3>
        <p>WebRTC mic with adjustable noise suppression, AGC, echo cancellation + custom input gain.</p>
      </div>
      <div class="card">
        <h3>Screenshare</h3>
        <p>Up to 4K/60fps with optional system audio. OS-level fullscreen + Picture-in-Picture.</p>
      </div>
      <div class="card">
        <h3>Webcam</h3>
        <p>Alongside screenshare or solo. PiP overlay when sharing both.</p>
      </div>
      <div class="card">
        <h3>Persistent chat</h3>
        <p>Per-room threads + 1:1 DMs over WebSocket. History kept in SQLite. Emoji picker built in.</p>
      </div>
      <div class="card">
        <h3>End-to-end encrypted DMs</h3>
        <p>NaCl box (X25519). Server stores ciphertext only — operator can't read.</p>
      </div>
      <div class="card">
        <h3>Friends + presence</h3>
        <p>Add by email. Online indicator. "Send DM" shortcut.</p>
      </div>
      <div class="card">
        <h3>2FA TOTP</h3>
        <p>Google Authenticator / Authy / 1Password compatible.</p>
      </div>
      <div class="card">
        <h3>Self-hostable</h3>
        <p>Run on your hardware. Cloudflare Tunnel friendly. <a href="https://github.com/R3dWolfie/R3DVoice/blob/main/docs/SELF_HOSTING.md">Setup guide</a>.</p>
      </div>
    </div>

    <h2 class="h2">Try it</h2>
    <p style="color:var(--text-mid);margin:0 0 16px;">
      Download the desktop client → register an account on this server → start a room.
      Or self-host your own instance.
    </p>
    <pre>git clone https://github.com/R3dWolfie/R3DVoice.git
cd R3DVoice
docs/SELF_HOSTING.md  # full walkthrough</pre>
  </div>
  <footer>
    Built by <a href="https://github.com/R3dWolfie">R3dWolfie</a>.
    AGPL-3.0 · running on a Linux box at home.
  </footer>
</body>
</html>
`;
