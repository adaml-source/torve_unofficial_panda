import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "..", ".data");
const SECRET_FILE = path.join(DATA_DIR, "signing-secret.txt");

async function loadOrCreateSecret() {
  if (process.env.PANDA_SECRET?.trim()) return process.env.PANDA_SECRET.trim();
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    return (await fs.readFile(SECRET_FILE, "utf8")).trim();
  } catch {
    const generated = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(SECRET_FILE, `${generated}\n`, "utf8");
    return generated;
  }
}

function deriveKey(secret, configId) {
  return crypto.createHmac("sha256", secret).update(`nzb-sign:${configId}`).digest();
}

export async function signNzbPayload(configId, { nzbUrl, title }) {
  const body = encodeBase64Url(JSON.stringify({ u: nzbUrl, t: title || "" }));
  const key = deriveKey(await loadOrCreateSecret(), configId);
  const sig = encodeBase64Url(crypto.createHmac("sha256", key).update(body).digest("base64"));
  return `${body}.${sig}`;
}

export async function verifyNzbPayload(configId, payload) {
  try {
    const [body, sig] = String(payload || "").split(".");
    if (!body || !sig) return null;
    const key = deriveKey(await loadOrCreateSecret(), configId);
    const expected = encodeBase64Url(crypto.createHmac("sha256", key).update(body).digest("base64"));
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(decodeBase64Url(body));
    if (typeof parsed?.u !== "string" || !parsed.u) return null;
    return { nzbUrl: parsed.u, title: typeof parsed.t === "string" ? parsed.t : "" };
  } catch {
    return null;
  }
}
