# R3DVoice infra

Local-dev Docker stack for the LiveKit media server.

## Run

```bash
cd infra
docker compose up
```

Leave it running in its own terminal. LiveKit listens on:

- `ws://localhost:7880` — signalling
- `UDP 50000-50020` — media
- `TCP 7881` — media fallback

## Shared dev secrets

`livekit.yaml` contains `devkey-r3dvoice` / `devsecret-r3dvoice-...`. The
`apps/server/.env` file must use the same pair so token minting works.

**These are DEV ONLY.** Generate fresh keys for any public deployment —
see Plan 4 for deployment guidance.
