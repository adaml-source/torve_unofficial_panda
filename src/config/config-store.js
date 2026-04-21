import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "..", ".data");
const DB_PATH = process.env.PANDA_DB_PATH || path.join(DATA_DIR, "panda.db");

let db = null;

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function getDb() {
  if (db) return db;

  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS configs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      config_json TEXT NOT NULL
    )
  `);
  return db;
}

export async function saveConfig(config) {
  await ensureDataDir();

  const database = getDb();
  const id = crypto.randomBytes(12).toString("hex");
  const timestamp = new Date().toISOString();

  database
    .prepare("INSERT INTO configs (id, created_at, updated_at, config_json) VALUES (?, ?, ?, ?)")
    .run(id, timestamp, timestamp, JSON.stringify(config));

  return { id, createdAt: timestamp, updatedAt: timestamp, config };
}

export async function getConfigRecord(configId) {
  await ensureDataDir();

  const database = getDb();
  const row = database
    .prepare("SELECT id, created_at, updated_at, config_json FROM configs WHERE id = ?")
    .get(configId);

  if (!row) return null;

  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: JSON.parse(row.config_json),
  };
}

// Secret fields that redactConfigSecrets masks when returning to the client.
// Keep in sync with the function below. Used by stripRedactionMarkers on the
// way back in so clients that blindly re-POST the redacted payload don't
// overwrite the stored secret with the literal "[redacted]" string.
const SECRET_FIELDS = [
  "debridApiKey",
  "debridCredentialCiphertext",
  "putioClientId",
  "usenetPassword",
  "nzbIndexerApiKey",
  "downloadClientPassword",
  "downloadClientApiKey",
];
const REDACTION_MARKER = "[redacted]";

export function redactConfigSecrets(config) {
  if (!config) {
    return null;
  }
  const out = { ...config };
  for (const f of SECRET_FIELDS) {
    out[f] = config[f] ? REDACTION_MARKER : "";
  }
  // Redact nested secrets inside nzbIndexers[].apiKey — same reasoning.
  if (Array.isArray(out.nzbIndexers)) {
    out.nzbIndexers = out.nzbIndexers.map((r) => r && typeof r === "object"
      ? { ...r, apiKey: r.apiKey ? REDACTION_MARKER : "" }
      : r);
  }
  return out;
}

/**
 * Drop the redaction markers from an incoming config body, replacing them
 * with the corresponding value from the existing saved config. Essential for
 * PATCH flows where the client re-sends the last GET response: the GET is
 * redacted, so the PATCH body contains "[redacted]" for every secret. Without
 * this, saving any config edit would overwrite every stored secret with the
 * literal string "[redacted]", breaking Easynews auth, debrid lookups, etc.
 *
 * POST (create) flow: `existing` is null; redaction markers are stripped to
 * "" so sanitizeConfig falls back to defaults instead of storing the marker.
 */
export function stripRedactionMarkers(body, existing = null) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  for (const f of SECRET_FIELDS) {
    if (out[f] === REDACTION_MARKER) {
      out[f] = existing?.[f] ?? "";
    }
  }
  if (Array.isArray(out.nzbIndexers)) {
    const existingArr = Array.isArray(existing?.nzbIndexers) ? existing.nzbIndexers : [];
    out.nzbIndexers = out.nzbIndexers.map((r, i) => {
      if (!r || typeof r !== "object") return r;
      if (r.apiKey !== REDACTION_MARKER) return r;
      return { ...r, apiKey: existingArr[i]?.apiKey ?? "" };
    });
  }
  return out;
}

/**
 * Update an existing config record by id. Used by /api/v1/configs/me PATCH.
 */
export async function updateConfig(configId, nextConfig) {
  await ensureDataDir();
  const database = getDb();
  const timestamp = new Date().toISOString();
  const result = database
    .prepare("UPDATE configs SET config_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(nextConfig), timestamp, configId);
  if (result.changes === 0) return null;
  return { id: configId, updatedAt: timestamp, config: nextConfig };
}

/**
 * Delete a config record by id. Used by /api/v1/configs/me DELETE.
 */
export async function deleteConfig(configId) {
  await ensureDataDir();
  const database = getDb();
  const result = database
    .prepare("DELETE FROM configs WHERE id = ?")
    .run(configId);
  return result.changes > 0;
}
