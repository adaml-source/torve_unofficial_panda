// NZB cloud download clients. Submit an NZB URL to a debrid-style service
// that downloads + unpacks on its own infrastructure, then returns a direct
// HTTPS stream URL. Panda does zero local storage of NZB content.
//
// Implemented: premiumize, torbox, alldebrid. Each resolver:
//   - submits the NZB (idempotently if possible)
//   - briefly polls for "ready"
//   - returns { url, filename, size } or null if not ready in time
// Caller is responsible for skipping null entries in the Stremio stream list.

import { TtlCache } from "../lib/ttl-cache.js";
import { createHash } from "node:crypto";
import { TorboxNzbResolver } from "./torbox-nzb.js";
export { NzbCloudError } from "./torbox-nzb.js";

const resolveCache = new TtlCache({ maxEntries: 2000 });
const CACHE_TTL_OK = 30 * 60 * 1000;   // 30 min for successful stream URL
const CACHE_TTL_FAIL = 60 * 1000;      // 1 min for failed/pending — retry soon

const CLOUD_CLIENTS = new Set(["premiumize", "torbox", "alldebrid"]);

// Per-resolution budget: the foreground poll only blocks the HTTP request
// briefly — long enough to catch items TorBox has already fully cached for
// another user, not so long that the player's HTTP timeout fires. Anything
// slower falls through to the background poll.
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 2000;

const VIDEO_RE = /\.(mkv|mp4|avi|mov|m4v|ts|wmv|mpg|mpeg)$/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isVideoFile(name) {
  return typeof name === "string" && VIDEO_RE.test(name);
}

function pickBestVideo(files) {
  return files
    .filter((f) => isVideoFile(f.name) && !/sample/i.test(f.name))
    .sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;
}

export function isCloudDownloadClient(client) {
  return CLOUD_CLIENTS.has(client);
}

// ── Premiumize ──

async function pmRequest(path, apiKey, body) {
  const url = `https://www.premiumize.me/api${path}`;
  const params = new URLSearchParams({ apikey: apiKey, ...(body || {}) });
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

async function pmGet(path, apiKey, query) {
  const params = new URLSearchParams({ apikey: apiKey, ...(query || {}) });
  return fetchJson(`https://www.premiumize.me/api${path}?${params}`);
}

async function premiumizeResolve(config, nzbUrl, title) {
  const apiKey = config.downloadClientApiKey;
  if (!apiKey) return null;

  // Submit transfer. PM dedupes by URL+name internally and near-instantly
  // finishes for any NZB it has already downloaded for any user.
  const create = await pmRequest("/transfer/create", apiKey, { src: nzbUrl, name: title || "" })
    .catch((err) => ({ status: "error", message: err.message }));
  if (create.status !== "success") return null;
  const transferId = create.id;

  // Poll. For PM-cached NZBs this almost always resolves on the first or
  // second check; uncached NZBs stay "running" and we return null, letting
  // PM finish the download in the background for next time.
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const list = await pmGet("/transfer/list", apiKey).catch(() => null);
    const t = list?.transfers?.find((x) => x.id === transferId);
    if (t?.status === "finished") {
      const folderId = t.folder_id;
      if (!folderId) return null;
      const folder = await pmGet("/folder/list", apiKey, { id: folderId }).catch(() => null);
      const files = (folder?.content || [])
        .filter((x) => x.type === "file")
        .map((x) => ({ name: x.name, size: Number(x.size) || 0, url: x.stream_link || x.link }));
      const best = pickBestVideo(files);
      return best ? { url: best.url, filename: best.name, size: best.size } : null;
    }
    if (t?.status === "error" || t?.status === "deleted") return null;
    if (attempt < POLL_ATTEMPTS - 1) await sleep(POLL_DELAY_MS);
  }

  return null;
}

// TorBox keeps one submission per account/source and returns pending promptly.
const torbox = new TorboxNzbResolver();

// ── AllDebrid ──

async function adGet(path, apiKey, query) {
  const params = new URLSearchParams({ apikey: apiKey, ...(query || {}) });
  return fetchJson(`https://api.alldebrid.com/v4.1${path}?${params}`);
}

function flattenAdFiles(nodes, acc = []) {
  for (const n of nodes || []) {
    if (n.e) flattenAdFiles(n.e, acc);
    else if (n.l) acc.push({ name: n.n, size: Number(n.s) || 0, link: n.l });
  }
  return acc;
}

async function allDebridResolve(config, nzbUrl, title) {
  const apiKey = config.downloadClientApiKey;
  if (!apiKey) return null;

  // AllDebrid's `/magnet/upload` accepts NZB URLs in the magnets[] param
  // too (same endpoint, URL is auto-detected by extension).
  const upload = await adGet("/magnet/upload", apiKey, { "magnets[]": nzbUrl }).catch(() => null);
  const m = upload?.data?.magnets?.[0];
  if (!m || m.error) return null;
  const magnetId = m.id;
  if (!magnetId) return null;

  // If AllDebrid already had this NZB cached the upload call often comes
  // back with `ready: true`; otherwise we poll `/magnet/status`.
  let isReady = m.ready === true;

  for (let attempt = 0; !isReady && attempt < POLL_ATTEMPTS; attempt++) {
    const status = await adGet("/magnet/status", apiKey, { id: magnetId }).catch(() => null);
    const s = status?.data?.magnets;
    if (s?.status === "Ready" || s?.statusCode === 4) { isReady = true; break; }
    if (s?.statusCode >= 5) return null; // error states
    if (attempt < POLL_ATTEMPTS - 1) await sleep(POLL_DELAY_MS);
  }
  if (!isReady) return null;

  const filesRes = await adGet("/magnet/files", apiKey, { "id[]": magnetId }).catch(() => null);
  const files = flattenAdFiles(filesRes?.data?.magnets?.[0]?.files);
  const best = pickBestVideo(files);
  if (!best) return null;

  const unlock = await adGet("/link/unlock", apiKey, { link: best.link }).catch(() => null);
  const streamUrl = unlock?.data?.link;
  return typeof streamUrl === "string"
    ? { url: streamUrl, filename: best.name, size: best.size }
    : null;
}

// ── Dispatcher ──

const RESOLVERS = {
  premiumize: premiumizeResolve,
  torbox: (config, url, title) => torbox.resolve(config, url, title),
  alldebrid: allDebridResolve,
};

/**
 * Resolve an NZB URL to a direct HTTPS stream URL via the configured cloud
 * download client. Null means pending; TorBox errors remain explicit failures.
 */
export async function resolveNzbViaDebrid(config, nzbUrl, title) {
  const client = config.downloadClient;
  const resolver = RESOLVERS[client];
  if (!resolver || !nzbUrl) return null;

  if (client === "torbox") return resolver(config, nzbUrl, title);
  const account = createHash("sha256").update(config.downloadClientApiKey || "").digest("hex");
  const cacheKey = `nzbcloud:${client}:${account}:${nzbUrl}`;
  return resolveCache.memoize(
    cacheKey,
    () => resolver(config, nzbUrl, title).catch(() => null),
    { pickTtl: (v) => (v ? CACHE_TTL_OK : CACHE_TTL_FAIL) },
  );
}
