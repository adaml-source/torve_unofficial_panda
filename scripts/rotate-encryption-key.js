/**
 * Rotate PANDA_ENCRYPTION_KEY: re-encrypt every ciphertext field in the
 * configs table from the old key to the new key.
 *
 * Usage:
 *   1. Generate a new 32-byte hex key: `openssl rand -hex 32`
 *   2. Put the new key in a file readable only by root:
 *        echo "new-key-hex" > /root/panda-new-key.txt
 *        chmod 600 /root/panda-new-key.txt
 *   3. Run this script with BOTH old and new keys in the env:
 *        PANDA_ENCRYPTION_KEY_OLD="$(head -1 /opt/panda/.env | grep KEY | cut -d= -f2)" \
 *        PANDA_ENCRYPTION_KEY_NEW="$(cat /root/panda-new-key.txt)" \
 *        node scripts/rotate-encryption-key.js
 *   4. Update /opt/panda/.env: PANDA_ENCRYPTION_KEY=<new_key>
 *   5. systemctl restart panda
 *   6. Verify: curl a stream endpoint; panda.db rows should still decrypt.
 *   7. Delete /root/panda-new-key.txt (it's only needed during rotation).
 *
 * Safe to abort mid-run: rows are processed one-at-a-time in a transaction
 * per row. A partial run leaves the DB in a mixed state (some rows on old
 * key, some on new) — BOTH keys must remain valid until migration finishes.
 *
 * Dry-run mode: pass --dry-run as argv to see what would change without writing.
 */
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.PANDA_DB_PATH || path.resolve("./.data/panda.db");
const DRY_RUN = process.argv.includes("--dry-run");

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const CIPHERTEXT_PREFIX = "v1:";
const SECRET_FIELDS = [
  "debridApiKey",
  "putioClientId",
  "usenetPassword",
  "nzbIndexerApiKey",
  "downloadClientPassword",
  "downloadClientApiKey",
  "debridCredentialCiphertext",
];

function loadKey(envName) {
  const hex = process.env[envName]?.trim();
  if (!hex) throw new Error(`${envName} must be set`);
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`${envName} must be 64 hex chars (32 bytes)`);
  }
  return Buffer.from(hex, "hex");
}

function decryptWith(key, ciphertext) {
  const [, ivB64, ctB64, tagB64] = String(ciphertext).split(":");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

function encryptWith(key, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

function rewrap(oldKey, newKey, v) {
  if (typeof v !== "string" || !v.startsWith(CIPHERTEXT_PREFIX)) return null;
  const plaintext = decryptWith(oldKey, v);
  return encryptWith(newKey, plaintext);
}

async function main() {
  const oldKey = loadKey("PANDA_ENCRYPTION_KEY_OLD");
  const newKey = loadKey("PANDA_ENCRYPTION_KEY_NEW");
  if (oldKey.equals(newKey)) {
    throw new Error("Old and new keys are identical — nothing to rotate");
  }

  const db = new DatabaseSync(DB_PATH);
  const rows = db.prepare("SELECT id, config_json FROM configs").all();
  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Rewrapping ${rows.length} configs in ${DB_PATH}…`);

  let changed = 0;
  let errors = 0;

  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.config_json); }
    catch { console.warn(`  ! ${row.id}: invalid JSON, skipping`); errors++; continue; }

    let rowChanged = false;
    try {
      for (const f of SECRET_FIELDS) {
        const rewrapped = rewrap(oldKey, newKey, parsed[f]);
        if (rewrapped !== null) { parsed[f] = rewrapped; rowChanged = true; }
      }
      if (Array.isArray(parsed.nzbIndexers)) {
        parsed.nzbIndexers = parsed.nzbIndexers.map((r) => {
          if (!r || typeof r !== "object") return r;
          const rewrapped = rewrap(oldKey, newKey, r.apiKey);
          if (rewrapped !== null) { rowChanged = true; return { ...r, apiKey: rewrapped }; }
          return r;
        });
      }
    } catch (err) {
      console.error(`  ! ${row.id}: decrypt with OLD key failed — ${err.message}`);
      errors++;
      continue;
    }

    if (!rowChanged) continue;
    if (!DRY_RUN) {
      db.prepare("UPDATE configs SET config_json = ? WHERE id = ?")
        .run(JSON.stringify(parsed), row.id);
    }
    changed++;
    console.log(`  ${DRY_RUN ? "would rewrap" : "✓"} ${row.id}`);
  }

  console.log(`\nDone. ${changed} ${DRY_RUN ? "would be rewrapped" : "rewrapped"}, ${errors} errors.`);
  if (!DRY_RUN && changed > 0) {
    console.log("\nNEXT STEPS:");
    console.log("  1. Update PANDA_ENCRYPTION_KEY in /opt/panda/.env to the new value.");
    console.log("  2. systemctl restart panda");
    console.log("  3. Verify config reads work (e.g. curl a stream endpoint).");
    console.log("  4. Delete any file that held the new key in plaintext during rotation.");
  }
}

main().catch((err) => {
  console.error("Rotation failed:", err);
  process.exit(1);
});
