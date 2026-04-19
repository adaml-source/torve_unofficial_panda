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

export function redactConfigSecrets(config) {
  if (!config) {
    return null;
  }

  return {
    ...config,
    debridApiKey: config.debridApiKey ? "[redacted]" : "",
    debridCredentialCiphertext: config.debridCredentialCiphertext ? "[redacted]" : "",
    putioClientId: config.putioClientId ? "[redacted]" : "",
  };
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
