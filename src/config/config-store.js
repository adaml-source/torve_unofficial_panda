import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";

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
  // Two-token model (added 2026-04-21):
  // - manifest_token_version: bumped to invalidate a leaked manifest URL
  //   without losing the stored config. Stream token carries its own tv;
  //   server rejects tokens whose tv doesn't match current row.
  // - management_token_hash: sha256 of the raw management token. The raw
  //   value is shown to the user exactly once at create-time and required
  //   as bearer on PATCH / DELETE / rotate endpoints. Null for legacy rows
  //   created before this change (those still accept the manifest token as
  //   fallback — users should rotate to establish a proper management token).
  // - owner_torve_user_id (added 2026-04-26): when a config is created by
  //   a caller authenticated as a Torve user, the user's UUID is recorded
  //   here. Management endpoints accept a valid Torve JWT for this user as
  //   an alternative to a management_token. Eliminates the
  //   "save the management_token now or lose access" UX problem entirely
  //   for Torve users; standalone (non-Torve) callers keep the
  //   management_token model.
  const cols = db.prepare("PRAGMA table_info(configs)").all().map(r => r.name);
  if (!cols.includes("manifest_token_version")) {
    db.exec("ALTER TABLE configs ADD COLUMN manifest_token_version INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.includes("management_token_hash")) {
    db.exec("ALTER TABLE configs ADD COLUMN management_token_hash TEXT");
  }
  if (!cols.includes("owner_torve_user_id")) {
    db.exec("ALTER TABLE configs ADD COLUMN owner_torve_user_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS ix_configs_owner_torve_user_id ON configs(owner_torve_user_id)");
  }
  return db;
}

/**
 * Encrypt every at-rest secret field on a config object in place, leaving
 * already-ciphertext values (`v1:...` prefix) untouched. Idempotent — safe
 * to call on a config that's already encrypted (e.g. read-then-save cycles).
 * Empty strings stay empty; non-string values coerce through String() first.
 */
async function encryptConfigForStorage(config) {
  if (!config || typeof config !== "object") return config;
  const out = { ...config };
  for (const field of ENCRYPTED_AT_REST) {
    const v = out[field];
    if (typeof v === "string" && v !== "" && !v.startsWith(CIPHERTEXT_PREFIX)) {
      out[field] = await encryptSecret(v);
    }
  }
  // Nested indexer API keys
  if (Array.isArray(out.nzbIndexers)) {
    out.nzbIndexers = await Promise.all(out.nzbIndexers.map(async (r) => {
      if (!r || typeof r !== "object") return r;
      const apiKey = r.apiKey;
      if (typeof apiKey === "string" && apiKey !== "" && !apiKey.startsWith(CIPHERTEXT_PREFIX)) {
        return { ...r, apiKey: await encryptSecret(apiKey) };
      }
      return r;
    }));
  }
  return out;
}

/**
 * Mirror of encryptConfigForStorage — decrypts ciphertext fields back to
 * plaintext for consumers (adapters, UI). Plaintext values (legacy rows
 * that haven't been re-saved since encryption was enabled) pass through.
 * Decryption failures return an empty string for that field and log —
 * never throw, because one corrupt field shouldn't nuke the whole config.
 */
async function decryptConfigFromStorage(config) {
  if (!config || typeof config !== "object") return config;
  const out = { ...config };
  for (const field of ENCRYPTED_AT_REST) {
    const v = out[field];
    if (typeof v === "string" && v.startsWith(CIPHERTEXT_PREFIX)) {
      try {
        out[field] = await decryptSecret(v);
      } catch (err) {
        console.warn(`[panda] Failed to decrypt ${field}:`, err.message);
        out[field] = "";
      }
    }
  }
  if (Array.isArray(out.nzbIndexers)) {
    out.nzbIndexers = await Promise.all(out.nzbIndexers.map(async (r) => {
      if (!r || typeof r !== "object") return r;
      const apiKey = r.apiKey;
      if (typeof apiKey === "string" && apiKey.startsWith(CIPHERTEXT_PREFIX)) {
        try {
          return { ...r, apiKey: await decryptSecret(apiKey) };
        } catch (err) {
          console.warn(`[panda] Failed to decrypt nzbIndexer apiKey:`, err.message);
          return { ...r, apiKey: "" };
        }
      }
      return r;
    }));
  }
  return out;
}

export async function saveConfig(config, { managementTokenHash = null, ownerTorveUserId = null } = {}) {
  await ensureDataDir();

  const database = getDb();
  const id = crypto.randomBytes(12).toString("hex");
  const timestamp = new Date().toISOString();

  const encrypted = await encryptConfigForStorage(config);
  database
    .prepare(
      "INSERT INTO configs (id, created_at, updated_at, config_json, manifest_token_version, management_token_hash, owner_torve_user_id) " +
      "VALUES (?, ?, ?, ?, 1, ?, ?)",
    )
    .run(id, timestamp, timestamp, JSON.stringify(encrypted), managementTokenHash, ownerTorveUserId);

  // Return the plaintext config the caller handed us, not the ciphertext
  // snapshot — callers may immediately do redactConfigSecrets on it.
  return {
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    config,
    manifestTokenVersion: 1,
    managementTokenHash,
    ownerTorveUserId,
  };
}

export async function getConfigRecord(configId) {
  await ensureDataDir();

  const database = getDb();
  const row = database
    .prepare(
      "SELECT id, created_at, updated_at, config_json, manifest_token_version, management_token_hash, owner_torve_user_id " +
      "FROM configs WHERE id = ?",
    )
    .get(configId);

  if (!row) return null;

  // DB rows store secrets encrypted (for rows saved after the at-rest
  // encryption change). Older rows may still be plaintext; decryptConfig
  // passes those through unchanged.
  const raw = JSON.parse(row.config_json);
  const config = await decryptConfigFromStorage(raw);

  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config,
    manifestTokenVersion: row.manifest_token_version || 1,
    managementTokenHash: row.management_token_hash || null,
    ownerTorveUserId: row.owner_torve_user_id || null,
  };
}

/**
 * Bump a config's manifest-token version, invalidating every outstanding
 * manifest URL for that config. Caller must issue a freshly-signed token
 * with the new version for the owner.
 */
export async function rotateManifestTokenVersion(configId) {
  await ensureDataDir();
  const database = getDb();
  const row = database
    .prepare("SELECT manifest_token_version FROM configs WHERE id = ?")
    .get(configId);
  if (!row) return null;
  const next = (row.manifest_token_version || 1) + 1;
  database
    .prepare("UPDATE configs SET manifest_token_version = ?, updated_at = ? WHERE id = ?")
    .run(next, new Date().toISOString(), configId);
  return next;
}

/**
 * Replace a config's management-token hash. Called when the user rotates
 * or first-time provisions a management token for a legacy row.
 */
export async function setManagementTokenHash(configId, hash) {
  await ensureDataDir();
  const database = getDb();
  const result = database
    .prepare("UPDATE configs SET management_token_hash = ?, updated_at = ? WHERE id = ?")
    .run(hash, new Date().toISOString(), configId);
  return result.changes > 0;
}

/**
 * Return all configs owned by a given Torve user, newest first.
 * Used by /configure to render the user's existing config in the form
 * instead of defaults, and by future "list my Panda configs" UIs.
 */
export async function getConfigsByOwner(torveUserId) {
  await ensureDataDir();
  const database = getDb();
  const rows = database
    .prepare(
      "SELECT id, created_at, updated_at, config_json, manifest_token_version, management_token_hash, owner_torve_user_id " +
      "FROM configs WHERE owner_torve_user_id = ? " +
      "ORDER BY datetime(updated_at) DESC",
    )
    .all(torveUserId);

  const out = [];
  for (const row of rows) {
    const raw = JSON.parse(row.config_json);
    const config = await decryptConfigFromStorage(raw);
    out.push({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      config,
      manifestTokenVersion: row.manifest_token_version || 1,
      managementTokenHash: row.management_token_hash || null,
      ownerTorveUserId: row.owner_torve_user_id,
    });
  }
  return out;
}

/**
 * Bind a Torve user as the owner of a config. Used by:
 *   - lazy-claim: when a config has owner_torve_user_id IS NULL and the
 *     first authenticated management call carries a Torve JWT, the calling
 *     user becomes the owner. Subsequent management ops require this user.
 *   - backfill: a one-shot script that walks torve-backend's user_integrations
 *     table and back-fills the owner column for pre-2026-04-26 configs.
 *
 * Refuses to overwrite an existing non-null owner — that would let a leaked
 * manifest token transfer ownership. Returns true on success.
 */
export async function setOwnerTorveUserId(configId, torveUserId, { allowOverwrite = false } = {}) {
  await ensureDataDir();
  const database = getDb();
  if (!allowOverwrite) {
    const existing = database
      .prepare("SELECT owner_torve_user_id FROM configs WHERE id = ?")
      .get(configId);
    if (!existing) return false;
    if (existing.owner_torve_user_id && existing.owner_torve_user_id !== torveUserId) {
      return false;
    }
  }
  const result = database
    .prepare("UPDATE configs SET owner_torve_user_id = ?, updated_at = ? WHERE id = ?")
    .run(torveUserId, new Date().toISOString(), configId);
  return result.changes > 0;
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
// Fields that get encrypted at rest with AES-256-GCM. Subset of SECRET_FIELDS
// — debridCredentialCiphertext is already a ciphertext produced elsewhere and
// must not be double-encrypted.
const ENCRYPTED_AT_REST = [
  "debridApiKey",
  "putioClientId",
  "usenetPassword",
  "nzbIndexerApiKey",
  "downloadClientPassword",
  "downloadClientApiKey",
];
const CIPHERTEXT_PREFIX = "v1:"; // matches encryptSecret() output format
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
  const encrypted = await encryptConfigForStorage(nextConfig);
  const result = database
    .prepare("UPDATE configs SET config_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(encrypted), timestamp, configId);
  if (result.changes === 0) return null;
  // Return the plaintext form to the caller — the encrypted snapshot is an
  // internal storage detail, not part of the API contract.
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
