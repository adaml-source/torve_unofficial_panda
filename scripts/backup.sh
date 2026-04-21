#!/usr/bin/env bash
#
# Panda encrypted backup — bundles panda.db + .env (the two files that
# together let you restore a working instance) into a single gpg-encrypted
# tarball.
#
# Why both: panda.db alone is unusable — every credential in it is
# ciphertext keyed by PANDA_ENCRYPTION_KEY, which lives in .env. Losing
# .env = losing every stored credential with no recovery path.
#
# Usage:
#   # Symmetric passphrase (simplest). Prompted interactively:
#   ./scripts/backup.sh /path/to/out-dir
#
#   # Public-key encryption (recommended for unattended cron):
#   RECIPIENT=ops@example.com ./scripts/backup.sh /path/to/out-dir
#
# Restore (manual, on a fresh host):
#   gpg --decrypt panda-backup-YYYYMMDD-HHMMSS.tar.gz.gpg > restored.tar.gz
#   tar xzf restored.tar.gz
#   cp -a restored/.data /opt/panda/
#   cp    restored/.env  /opt/panda/
#   chown -R www-data:www-data /opt/panda/.data /opt/panda/.env
#   chmod 700 /opt/panda/.data ; chmod 600 /opt/panda/.data/* /opt/panda/.env
#   systemctl restart panda
#
# CAVEATS:
#   - Writes an unencrypted tarball to /tmp briefly during packaging. Use a
#     ramfs-backed /tmp (systemd default) or wipe /tmp after you're done.
#   - Does not include /var/log/panda/audit.log. If you need that for
#     compliance retention, back it up separately — it's less sensitive
#     (no secrets, only event metadata).

set -euo pipefail

OUT_DIR="${1:-/root/panda-backups}"
PANDA_DIR="/opt/panda"
STAGING="$(mktemp -d -t panda-backup-XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
TAR="$STAGING/panda-backup-$STAMP.tar.gz"
OUT="$OUT_DIR/panda-backup-$STAMP.tar.gz.gpg"

echo "[backup] staging → $STAGING"
mkdir "$STAGING/restored"
cp -a "$PANDA_DIR/.data" "$STAGING/restored/.data"
cp    "$PANDA_DIR/.env"  "$STAGING/restored/.env"

echo "[backup] packaging tarball"
tar -C "$STAGING" -czf "$TAR" restored

echo "[backup] encrypting → $OUT"
if [[ -n "${RECIPIENT:-}" ]]; then
  gpg --batch --yes --encrypt --recipient "$RECIPIENT" --output "$OUT" "$TAR"
else
  # Symmetric — prompts for passphrase. Use --batch + --passphrase for cron.
  gpg --symmetric --cipher-algo AES256 --output "$OUT" "$TAR"
fi

chmod 600 "$OUT"
echo "[backup] done: $OUT"
echo "[backup] size: $(du -h "$OUT" | cut -f1)"
echo
echo "RECOVERY: gpg --decrypt '$OUT' > restore.tar.gz && tar xzf restore.tar.gz"
