# R3DVoice

Open-source, self-hostable voice + screenshare for friends, raid nights, and the people you actually want to hear.

**Status:** v0.3.0 shipped. Persistent chat, DMs, friend list with online presence, 2FA, webcam alongside screenshare, picture-in-picture, deep links (`r3dvoice://join/<id>`), public-server picker, auto-update, splash window, opt-in crash reporting. Self-host via Cloudflare Tunnel — see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Features

- **Voice** — low-latency mic with WebRTC noise suppression / AGC / echo cancellation + custom input gain
- **Screenshare** — up to 4K/60fps, optional system audio, OS-level fullscreen, Picture-in-Picture
- **Webcam** — alongside screenshare or solo
- **Persistent chat** — per-room threads + 1:1 DMs over WebSocket, history kept in SQLite
- **Friends** — add by email, accept/reject, online presence indicator, "Send DM" shortcut
- **2FA TOTP** — Google Authenticator / Authy / 1Password compatible
- **End-to-end encrypted DMs** — NaCl box (X25519 + XSalsa20-Poly1305); server stores ciphertext only
- **Self-hostable** — runs on your hardware; no third-party servers required
- **Auto-update** — silent install on quit; deep links survive
- **Cross-OS** — Linux (AppImage / deb), Windows (NSIS), macOS (dmg)

## Repo Layout (monorepo, pnpm)

- `apps/server` — Node/Fastify HTTP API (accounts, rooms, chat, friends, LiveKit token minting)
- `apps/client` — Electron + React desktop client
- `packages/shared` — TypeScript types shared across client + server
- `infra/` — Docker Compose for the LiveKit media server
- `docs/SELF_HOSTING.md` — full self-host guide (Cloudflare Tunnel, systemd, ports)

## Local development (three terminals)

```bash
# Prerequisites: Node ≥22, pnpm ≥9, Docker + Docker Compose

pnpm install

# Terminal 1: LiveKit media server
cd infra && docker compose up

# One-time DB init (if you haven't)
cd apps/server && pnpm prisma migrate dev
cd ../..

# Terminal 2: app-server
pnpm server:dev

# Terminal 3: Electron client
pnpm --filter @r3dvoice/client dev
```

## Try it with two users

Launch the client twice (each run opens its own window). Register two separate accounts, have both join the same room, talk into your mic — you should hear yourself in the other window.

Screenshare: tick "Share a screen" in the pre-join check, click "Join now", pick a window or monitor in the OS prompt.

## Environment variables (server)

| Var | Description | Example |
|---|---|---|
| `DATABASE_URL` | Prisma SQLite URL | `file:./dev.db` |
| `JWT_SECRET` | ≥32-char secret for session JWTs | random 32+ bytes |
| `LIVEKIT_URL` | WebSocket URL of the LiveKit server | `ws://localhost:7880` |
| `LIVEKIT_API_KEY` | LiveKit API key (matches `infra/livekit.yaml`) | `devkey-r3dvoice` |
| `LIVEKIT_API_SECRET` | ≥32-char LiveKit API secret | `devsecret-r3dvoice-devsecret-r3dvoice-32` |
| `PORT` | HTTP port (optional) | `3000` |
| `HOST` | Bind address (optional) | `0.0.0.0` |

## Cross-OS notes

| OS | Screenshare | System audio | Notes |
|---|---|---|---|
| **Windows** | Works | Works (`loopback`) | No extra setup |
| **Linux (XWayland)** | Works | Works via PipeWire portal | Enable "Compatibility mode" in Settings if on native Wayland and screenshare is glitchy |
| **Linux (Wayland native)** | Works (picker UX varies by compositor) | Requires `xdg-desktop-portal` ≥ 1.14 | |
| **macOS** | Works | Limited (needs permission) | Grant Screen Recording permission in System Settings → Privacy & Security |

## HTTP API

All non-auth endpoints require `Authorization: Bearer <jwt>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Create account, return session JWT |
| POST | `/auth/login` | Password login, returns JWT or `requiresTotp` |
| POST | `/auth/login/totp` | Second step when 2FA enabled |
| POST | `/auth/logout` | Revoke current session |
| POST | `/auth/2fa/enroll-start` | Generate TOTP secret + QR |
| POST | `/auth/2fa/enroll-verify` | Confirm + activate 2FA |
| POST | `/auth/2fa/disable` | Disable 2FA |
| POST | `/auth/e2ee/public-key` | Update E2EE public key |
| GET  | `/me` | Current user |
| GET  | `/users/:id/public-key` | Look up another user's E2EE public key |
| GET  | `/rooms` | Your owned + recent rooms |
| POST | `/rooms` | Create room |
| GET  | `/rooms/:id` | Room metadata |
| POST | `/rooms/:id/token` | LiveKit access token for this room |
| GET  | `/chat/messages` | Paginated message history |
| POST | `/chat/messages` | Send |
| PATCH | `/chat/messages/:id` | Edit (author only) |
| DELETE | `/chat/messages/:id` | Soft delete (author only) |
| GET  | `/chat/dm-threads` | List of DM threads |
| GET  | `/friends` | Friend list with online status |
| POST | `/friends/request` | Send friend request by email |
| POST | `/friends/:id/accept` | Accept |
| POST | `/friends/:id/reject` | Reject / cancel / unfriend |
| GET  | `/health` | Liveness check |
| WS   | `/ws` | Live chat events (auth via `Sec-WebSocket-Protocol: r3dvoice.bearer.<jwt>`) |

## License

AGPL-3.0. If you run a public instance, you must offer the source.
