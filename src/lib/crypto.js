/**
 * Symmetric encryption for provider credentials at rest.
 *
 * Uses AES-256-GCM via node:crypto (no external deps).
 *
 * Key loaded from PANDA_ENCRYPTION_KEY env var (64 hex chars, 32 bytes).
 * If unset, generates a persistent key in .data/encryption-key.txt and warns.
 * Production MUST set PANDA_ENCRYPTION_KEY — rotating the env value without
 * decrypting existing rows will make stored credentials unreadable.
 *
 * Separate from PANDA_SECRET which is HMAC signing only.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "..", ".data");
const KEY_FILE = path.join(DATA_DIR, "encryption-key.txt");

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey = null;

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadOrCreateKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.PANDA_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    if (fromEnv.length !== 64 || !/^[0-9a-f]+$/i.test(fromEnv)) {
      throw new Error("PANDA_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
    }
    cachedKey = Buffer.from(fromEnv, "hex");
    return cachedKey;
  }

  await ensureDataDir();
  try {
    const existing = (await fs.readFile(KEY_FILE, "utf8")).trim();
    cachedKey = Buffer.from(existing, "hex");
    return cachedKey;
  } catch {
    const generated = crypto.randomBytes(32);
    await fs.writeFile(KEY_FILE, `${generated.toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
    console.warn("[panda] PANDA_ENCRYPTION_KEY not set — generated persistent key at .data/encryption-key.txt. SET THIS IN PRODUCTION.");
    cachedKey = generated;
    return cachedKey;
  }
}

/**
 * Encrypt a plaintext string. Returns "v1:iv:ciphertext:tag" (all base64).
 */
export async function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === "") return "";
  const key = await loadOrCreateKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

/**
 * Decrypt a ciphertext string produced by encryptSecret. Returns the
 * original plaintext. Throws if tampered or wrong key.
 */
export async function decryptSecret(ciphertext) {
  if (!ciphertext) return "";
  const parts = String(ciphertext).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted secret format");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const key = await loadOrCreateKey();
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Invalid encrypted secret lengths");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}
