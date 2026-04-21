# Panda Security Model

Panda stores third-party service credentials (debrid API keys, Usenet
passwords, NZB indexer keys, cloud-download-client keys) on behalf of
end users. This document is the internal reference for how that's
protected and how to respond when something goes wrong.

## Threat model (what we protect against)

| Scenario | Control |
|---|---|
| DB backup / snapshot leak | All secrets encrypted at rest with `PANDA_ENCRYPTION_KEY` |
| Non-Panda local user reads `panda.db` | `/opt/panda/.data/` is `0700`, files `0600`, owned by `www-data` |
| Manifest URL shared / leaked | Attacker can only stream; no read/edit access to credentials (two-token model) |
| Management token shared / leaked | Rotate via `POST /api/v1/configs/me/rotate-management` |
| Unauthorized write to config | Mutating endpoints (`PATCH`/`DELETE`/`rotate-*`) require management token + `X-Panda-Config-Id` header |
| Token replay after "leak noticed" | `rotate-manifest` bumps `manifest_token_version`; stale manifest tokens return 404 |
| Client sending back redacted response | `stripRedactionMarkers` restores real stored value instead of storing literal `"[redacted]"` |

## Tokens

Panda issues two distinct tokens per config:

**Manifest token** — signed HMAC embedded in the `/u/<token>/manifest.json`
URL. Versioned (payload `tv: N`). Grants stream access only.
Rotatable via bumping `manifest_token_version`.

**Management token** — opaque 32-byte hex string. Shown to the user
ONCE, at creation time. Only the sha256 hash is persisted
(`management_token_hash` column). Required for every mutating
operation, sent as:

```
Authorization: Bearer <management_token>
X-Panda-Config-Id: <config_id>
```

## Encryption at rest

AES-256-GCM via `src/lib/crypto.js`. Key loaded from
`PANDA_ENCRYPTION_KEY` env var (64 hex chars, 32 bytes). If unset,
a persistent key is auto-generated at `.data/encryption-key.txt`
with a startup warning — **never run production without the env var
set**.

Ciphertext format: `v1:<iv_b64>:<ct_b64>:<tag_b64>`. Plaintext values
(legacy rows not yet resaved) pass through decrypt unchanged for
backward-compat.

Fields encrypted at rest:

- `debridApiKey`
- `debridCredentialCiphertext` (double-encrypted — original ciphertext
  produced by the debrid OAuth flow, re-wrapped with the at-rest key;
  both layers use the same key; fine in practice)
- `putioClientId`
- `usenetPassword`
- `nzbIndexerApiKey`
- `nzbIndexers[].apiKey` (per-entry)
- `downloadClientPassword`
- `downloadClientApiKey`

Everything else in the config is non-sensitive metadata.

## Audit log

Every mutating event writes one JSON line to
`/var/log/panda/audit.log`. Schema documented in `src/lib/audit.js`.
No secrets ever enter the log — only `{config_id, ip, user_agent,
auth_method, action, success}`. Rotated weekly via
`/etc/logrotate.d/panda`.

Grep patterns:

```sh
# All failed mutating attempts against one config
grep '"config_id":"abc123"' /var/log/panda/audit.log | grep '"success":false'

# Rotation events in the last week
grep '"action":"rotate_' /var/log/panda/audit.log
```

## Operational playbooks

### Customer says their manifest URL leaked

1. Ask them to confirm current management token still works.
2. Have them call `POST /api/v1/configs/me/rotate-manifest` via the
   app UI (Settings → Panda → Rotate manifest). This bumps
   `manifest_token_version` — old URL returns 404 immediately.
3. User updates the installed Panda addon with the new manifest URL.

### Customer says their management token leaked

1. Have them call `POST /api/v1/configs/me/rotate-management` via the
   app UI (Settings → Panda → Rotate management token). App captures
   the new token, stores it, shows user once.
2. Old management token rejected on all future auth attempts.

### Customer says they've lost their management token

Two paths:

1. **Support-issued token** (no session proof): run `scripts/
   provision-management-tokens.js` to mint one for the config. Deliver
   out-of-band (email, signed support channel). User pastes into the
   "I need a management token" recovery flow in the app.
2. **Can't wait / don't care about settings**: user uninstalls Panda,
   re-onboards. Fresh config, fresh tokens.

### You suspect `PANDA_ENCRYPTION_KEY` has leaked

1. Generate a new key: `openssl rand -hex 32`.
2. Save it somewhere locked down: `echo "NEW_KEY" > /root/panda-new-key.txt;
   chmod 600 /root/panda-new-key.txt`.
3. Run the rotation with BOTH keys in the env:
   ```sh
   cd /opt/panda
   source .env
   PANDA_ENCRYPTION_KEY_OLD="$PANDA_ENCRYPTION_KEY" \
   PANDA_ENCRYPTION_KEY_NEW="$(cat /root/panda-new-key.txt)" \
   node scripts/rotate-encryption-key.js --dry-run
   ```
   Dry-run first. Then remove `--dry-run` and re-run.
4. Update `/opt/panda/.env`: `PANDA_ENCRYPTION_KEY=<new>`.
5. `systemctl restart panda`
6. Verify: `curl` a stream endpoint; successful response means rows
   decrypt fine.
7. Delete `/root/panda-new-key.txt`.

No downtime is required — Panda reads the env key only at process
start, so as long as the migration completes before restart, the
running process continues to decrypt with the old key until killed.

### You suspect the server is compromised

Out of scope for this doc — this is an OS-level incident. At a
minimum: rotate `PANDA_ENCRYPTION_KEY`, rotate `PANDA_SECRET`
(invalidates all manifest tokens; users re-onboard),
`scripts/provision-management-tokens.js` to reissue management
tokens, email every customer, review `/var/log/panda/audit.log`
for the last 90 days, file incident report.

## Backups

**`panda.db` and `.env` must both be backed up.** Losing `.env` =
losing `PANDA_ENCRYPTION_KEY` = every ciphertext in the DB
unreadable. Treat backups as credential material: encrypted,
access-logged, retention bounded.

Backup strategy that does NOT work:
- DB only (no env) → can't decrypt
- DB + env in the same tar / S3 bucket with the same IAM role →
  a single credential compromise leaks both

Minimum acceptable: DB in one backup, `.env` in a separate
credential store (password manager, Vault, KMS).
