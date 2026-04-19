import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "..", ".data");
const STORE_FILE = path.join(DATA_DIR, "configs.json");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStore() {
  await ensureDataDir();

  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.configs && typeof parsed.configs === "object") {
      return parsed;
    }
  } catch {
    // Fall through to the empty store.
  }

  return {
    version: 1,
    configs: {}
  };
}

async function writeStore(store) {
  await ensureDataDir();
  const tempFile = `${STORE_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tempFile, STORE_FILE);
}

export async function saveConfig(config) {
  const store = await readStore();
  const id = crypto.randomBytes(12).toString("hex");
  const timestamp = new Date().toISOString();

  store.configs[id] = {
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    config
  };

  await writeStore(store);
  return store.configs[id];
}

export async function getConfigRecord(configId) {
  const store = await readStore();
  return store.configs[configId] || null;
}

export function redactConfigSecrets(config) {
  if (!config) {
    return null;
  }

  return {
    ...config,
    debridApiKey: config.debridApiKey ? "[redacted]" : "",
    putioClientId: config.putioClientId ? "[redacted]" : ""
  };
}
