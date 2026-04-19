# Panda

Panda is a standalone addon service for Torve.

Its job is to make streaming setup easier for non-power users while still leaving room for advanced users to customize providers, debrid backends, quality policy, and source behavior.

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

Panda follows a simple but safer model than raw manifest configuration links:

1. the user configures Panda through `/configure`
2. Panda stores the config and any debrid secret server-side
3. Panda returns a signed addon token
4. the manifest URL references only that signed token
5. stream requests resolve the stored config server-side and proxy Torrentio

This is still an early implementation and does not yet include a database, auth layer, or encryption-at-rest, but it is already materially better than embedding debrid secrets into a public manifest URL.

## Next milestones

1. Add a proper persistent backend store instead of local JSON files.
2. Add config editing and account-specific management flows.
3. Add more upstream adapters beyond Torrentio.
4. Add catalogs, metadata, and subtitle expansion where useful.
5. Deploy Panda to a stable public domain and point Torve defaults at it.
