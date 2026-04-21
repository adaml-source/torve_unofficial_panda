/**
 * One-time migration: encrypt every at-rest secret in the configs table.
 *
 * Safe to re-run — the encryptConfigForStorage logic skips fields that
 * already start with the "v1:" ciphertext prefix, so idempotent.
 *
 * Usage (from /opt/panda):
 *   PANDA_SECRET=... PANDA_ENCRYPTION_KEY=... node scripts/migrate-encrypt-secrets.js
 *
 * Read the .env first:
 *   set -a; source .env; set +a; node scripts/migrate-encrypt-secrets.js
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { encryptSecret } from "../src/lib/crypto.js";

const DB_PATH = process.env.PANDA_DB_PATH || path.resolve("./.data/panda.db");
const CIPHERTEXT_PREFIX = "v1:";

const FIELDS = [
  "debridApiKey",
  "putioClientId",
  "usenetPassword",
  "nzbIndexerApiKey",
  "downloadClientPassword",
  "downloadClientApiKey",
];

async function encryptIfNeeded(v) {
  if (typeof v !== "string" || v === "" || v.startsWith(CIPHERTEXT_PREFIX)) return v;
  return await encryptSecret(v);
}

async function migrateConfig(raw) {
  let changed = false;
  const out = { ...raw };
  for (const f of FIELDS) {
    const newVal = await encryptIfNeeded(out[f]);
    if (newVal !== out[f]) { out[f] = newVal; changed = true; }
  }
  if (Array.isArray(out.nzbIndexers)) {
    const next = await Promise.all(out.nzbIndexers.map(async (r) => {
      if (!r || typeof r !== "object") return r;
      const enc = await encryptIfNeeded(r.apiKey);
      if (enc !== r.apiKey) { changed = true; return { ...r, apiKey: enc }; }
      return r;
    }));
    out.nzbIndexers = next;
  }
  return { config: out, changed };
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  const rows = db.prepare("SELECT id, config_json FROM configs").all();
  console.log(`Scanning ${rows.length} configs in ${DB_PATH}…`);

  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.config_json); }
    catch { console.warn(`Skipping ${row.id}: invalid JSON`); continue; }

    const { config, changed } = await migrateConfig(parsed);
    if (!changed) { skipped++; continue; }

    db.prepare("UPDATE configs SET config_json = ? WHERE id = ?")
      .run(JSON.stringify(config), row.id);
    migrated++;
    console.log(`  ✓ ${row.id}`);
  }

  console.log(`\nDone. ${migrated} migrated, ${skipped} already encrypted / empty.`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
