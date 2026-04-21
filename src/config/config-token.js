import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBase64Url, encodeBase64Url } from "../lib/base64url.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "..", ".data");
const SECRET_FILE = path.join(DATA_DIR, "signing-secret.txt");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadOrCreateSecret() {
  if (process.env.PANDA_SECRET?.trim()) {
    return process.env.PANDA_SECRET.trim();
  }

  await ensureDataDir();

  try {
    return (await fs.readFile(SECRET_FILE, "utf8")).trim();
  } catch {
    const generatedSecret = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(SECRET_FILE, `${generatedSecret}\n`, "utf8");
    return generatedSecret;
  }
}

function createSignature(payload, secret) {
  return encodeBase64Url(
    crypto.createHmac("sha256", secret).update(payload).digest("base64")
  );
}

/**
 * Encode a manifest-URL token. A version number is embedded so rotating the
 * manifest token (without destroying the config) is possible — server bumps
 * `manifestTokenVersion` on the config row, any token carrying a stale
 * version fails decode. If version is omitted defaults to 1 for backward
 * compat with existing tokens created before the versioning change.
 */
export async function encodeConfigToken(configId, version = 1) {
  const payload = encodeBase64Url(JSON.stringify({
    version: 1,            // envelope format version (unrelated to token rotation version)
    configId,
    tv: version,           // manifest-token rotation version
  }));
  const signature = createSignature(payload, await loadOrCreateSecret());
  return `${payload}.${signature}`;
}

/**
 * Returns { configId, tokenVersion } on success, null on bad signature /
 * malformed payload. Callers cross-reference tokenVersion against the
 * config row's current manifestTokenVersion to enforce rotation.
 */
export async function decodeConfigToken(token) {
  try {
    const [payload, signature] = String(token || "").split(".");
    if (!payload || !signature) {
      return null;
    }

    const secret = await loadOrCreateSecret();
    const expectedSignature = createSignature(payload, secret);
    const providedSignature = Buffer.from(signature, "utf8");
    const validSignature = Buffer.from(expectedSignature, "utf8");

    if (
      providedSignature.length !== validSignature.length ||
      !crypto.timingSafeEqual(providedSignature, validSignature)
    ) {
      return null;
    }

    const parsed = JSON.parse(decodeBase64Url(payload));
    if (typeof parsed?.configId !== "string" || !parsed.configId) return null;
    // tv is 1 for pre-rotation tokens that never carried the field
    const tokenVersion = typeof parsed?.tv === "number" ? parsed.tv : 1;
    return { configId: parsed.configId, tokenVersion };
  } catch {
    return null;
  }
}
