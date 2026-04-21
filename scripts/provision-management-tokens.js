/**
 * One-off migration: mint a management token for every config that doesn't
 * have one yet. Raw tokens are printed to stdout ONCE; only sha256 hashes are
 * persisted. Redirect stdout to a 0600 file or pipe directly to your
 * password manager / customer-delivery workflow.
 *
 * Safe to re-run — configs that already have a management_token_hash are
 * skipped (printed with status "already_provisioned").
 *
 * Usage (from /opt/panda):
 *   set -a; source .env; set +a
 *   node scripts/provision-management-tokens.js > /root/panda-mgmt-tokens.txt
 *   chmod 600 /root/panda-mgmt-tokens.txt
 */
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.PANDA_DB_PATH || path.resolve("./.data/panda.db");

function mintToken() {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  // Make sure the columns exist (in case script runs before first server boot)
  const cols = db.prepare("PRAGMA table_info(configs)").all().map(r => r.name);
  if (!cols.includes("management_token_hash")) {
    db.exec("ALTER TABLE configs ADD COLUMN management_token_hash TEXT");
  }

  const rows = db.prepare(
    "SELECT id, management_token_hash FROM configs ORDER BY created_at",
  ).all();

  console.log(`# Panda management-token provisioning — ${new Date().toISOString()}`);
  console.log(`# DB: ${DB_PATH}`);
  console.log(`# ${rows.length} configs scanned\n`);

  let provisioned = 0;
  let already = 0;
  for (const row of rows) {
    if (row.management_token_hash) {
      console.log(`${row.id}\talready_provisioned`);
      already++;
      continue;
    }
    const { raw, hash } = mintToken();
    db.prepare("UPDATE configs SET management_token_hash = ? WHERE id = ?").run(hash, row.id);
    console.log(`${row.id}\t${raw}`);
    provisioned++;
  }

  console.log(`\n# Provisioned ${provisioned} tokens; ${already} already had one.`);
  console.log(`# Raw tokens above are shown ONLY in this output — Panda stores the sha256 hash.`);
  console.log(`# Distribute each token to the corresponding customer out-of-band.`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
