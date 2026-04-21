# Panda

Panda is a standalone, open-source (MIT-licensed) addon service for
[Torve](https://torve.app). It is consumed by a wrapping user-facing
service — the reference deployment is Torve, but nothing in the design
is Torve-specific. Anyone can self-host Panda or integrate it into
another Stremio-compatible client.

Its job is to make streaming setup easier for non-power users while
still leaving room for advanced users to customize providers, debrid
backends, quality policy, and source behavior.

## Current v1 shape

Panda is now a working Node-based addon service with:

- a Stremio-compatible manifest
- a guided `/configure` page
- server-side config persistence
- signed config tokens in addon URLs
- server-side storage for debrid credentials
- a Torrentio-backed stream proxy

The important design point is that debrid credentials are not embedded in the manifest URL. Panda stores them server-side and only exposes a signed token that resolves to the saved config.

## Why Panda exists

Torve currently works, but onboarding is still too fragmented for normal users:

- app-side debrid setup
- addon-side source setup
- stream filtering spread across app and addon choices

Panda is the place to centralize stream-source configuration:

- provider enablement
- debrid selection
- quality profiles
- release language preferences
- result filtering and sorting
- guided setup with sane defaults

Torve can then keep focusing on the app experience:

- playback
- library
- downloads
- watch history
- account sync

## Implemented endpoints

- `GET /`
- `GET /healthz`
- `GET /manifest.json`
- `GET /configure`
- `POST /api/configs`
- `GET /u/:token/manifest.json`
- `GET /u/:token/stream/:type/:id.json`
- `GET /debug/config/:token`
- `GET /logo.svg`

## Run locally

Requirements:

- Node.js 20+

Start:

```bash
npm start
```

Then open:

- `http://localhost:7000/`
- `http://localhost:7000/configure`
- `http://localhost:7000/manifest.json`

## Environment

Optional environment variables:

- `PORT`
- `HOST`
- `PANDA_SECRET`
- `TORRENTIO_BASE_URL`

If `PANDA_SECRET` is not set, Panda creates a local signing secret in `.data/signing-secret.txt`.

Saved configs are stored in `.data/configs.json`.

## Security model

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full threat model,
token architecture, encryption scheme, audit log, backup strategy, and
incident response playbooks.

Headline properties:

- AES-256-GCM at rest for every stored credential
- Two separate tokens per config (manifest for streams, management for
  edits) — a leaked stream URL cannot steal or modify credentials
- Rotation endpoints for both tokens
- GDPR data-export and erasure endpoints
- Audit log at `/var/log/panda/audit.log` with 12-week retention

## License

MIT. See [`LICENSE`](LICENSE).
