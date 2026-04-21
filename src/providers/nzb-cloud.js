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

// Background poll for fresh downloads that TorBox hasn't finished yet. When
// the foreground budget expires, this keeps polling and writes the resolved
// stream URL into resolveCache so the user's next click (after their 60s
// FAIL TTL has elapsed) finds a ready entry instantly.
const BG_POLL_ATTEMPTS = 30;
const BG_POLL_DELAY_MS = 10000;   // ~5 min total background lifetime
const backgroundPollsInFlight = new Set();

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

// ── TorBox ──

async function torboxRequest(path, apiKey, init = {}) {
  const url = `https://api.torbox.app/v1/api${path}`;
  const headers = { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) };
  return fetchJson(url, { ...init, headers });
}

// 50 MB cap on fetched NZB XML. Ordinary NZBs are 1-5 MB, but large 4K
// remuxes with thousands of parts legitimately produce 10-20 MB files,
// and some scene releases with many PAR2 blocks push higher. 50 MB is
// still well below anything suspicious while covering real content.
const NZB_FETCH_MAX_BYTES = 50 * 1024 * 1024;
const NZB_FETCH_TIMEOUT_MS = 15000;

async function fetchNzbAsBlob(nzbUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NZB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(nzbUrl, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`NZB fetch HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > NZB_FETCH_MAX_BYTES) throw new Error(`NZB too large: ${len} bytes`);
    const blob = await res.blob();
    if (blob.size > NZB_FETCH_MAX_BYTES) throw new Error(`NZB too large: ${blob.size} bytes`);
    return blob;
  } finally {
    clearTimeout(timeout);
  }
}

async function torboxResolve(config, nzbUrl, title) {
  const apiKey = config.downloadClientApiKey;
  if (!apiKey) return null;

  // Fetch the NZB on Panda's side and hand TorBox the raw bytes as a
  // multipart upload. TorBox's `link` param silently fails (500 error)
  // on indexer URLs it can't fetch from its own network — multipart
  // upload bypasses that entirely and dedupes against existing downloads
  // by NZB hash server-side.
  let nzbBlob;
  try {
    nzbBlob = await fetchNzbAsBlob(nzbUrl);
  } catch (err) {
    console.error(`TorBox: NZB fetch failed: ${err.message}`);
    return null;
  }

  const form = new FormData();
  form.append("file", nzbBlob, "source.nzb");
  if (title) form.append("name", title);

  const create = await fetchJson("https://api.torbox.app/v1/api/usenet/createusenetdownload", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  }, 30000).catch(() => null);
  if (!create?.success) return null;
  const dlId = create.data?.usenetdownload_id || create.data?.hash;
  if (!dlId) return null;

  // Inner poll — returns "failed" for terminal errors, a stream object when
  // ready, or null when still downloading. Shared by foreground and
  // background loops.
  const pollOnce = async () => {
    const listRes = await torboxRequest(`/usenet/mylist?id=${encodeURIComponent(dlId)}`, apiKey)
      .catch(() => null);
    const dl = listRes?.data;
    const isReady = dl?.download_state === "completed"
      || dl?.download_finished === true
      || (dl?.progress === 1 && Array.isArray(dl?.files) && dl.files.length > 0);
    if (isReady) {
      const files = (dl.files || []).map((f) => ({ name: f.name || f.short_name, size: Number(f.size) || 0, id: f.id }));
      const best = pickBestVideo(files);
      if (!best) return "failed";
      const urlRes = await torboxRequest(
        `/usenet/requestdl?token=${encodeURIComponent(apiKey)}&usenet_id=${encodeURIComponent(dlId)}&file_id=${encodeURIComponent(best.id)}`,
        apiKey,
      ).catch(() => null);
      const streamUrl = urlRes?.data;
      return typeof streamUrl === "string"
        ? { url: streamUrl, filename: best.name, size: best.size }
        : "failed";
    }
    if (dl?.download_state === "failed" || dl?.download_state === "error") return "failed";
    return null;
  };

  // Foreground: blocks the incoming HTTP request for POLL_ATTEMPTS × POLL_DELAY_MS.
  // Resolves most TorBox-cached items (other user downloaded them before).
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const r = await pollOnce().catch(() => null);
    if (r === "failed") return null;
    if (r) return r;
    if (attempt < POLL_ATTEMPTS - 1) await sleep(POLL_DELAY_MS);
  }

  // Background: continue polling after the request returns, so the user's
  // retry (typically 60+ seconds later, after resolveCache FAIL TTL expires)
  // finds a cached success entry and 302s immediately.
  const cacheKey = `nzbcloud:torbox:${nzbUrl}`;
  if (!backgroundPollsInFlight.has(cacheKey)) {
    backgroundPollsInFlight.add(cacheKey);
    (async () => {
      try {
        for (let i = 0; i < BG_POLL_ATTEMPTS; i++) {
          await sleep(BG_POLL_DELAY_MS);
          const r = await pollOnce().catch(() => null);
          if (r === "failed") return;
          if (r) { resolveCache.set(cacheKey, r, CACHE_TTL_OK); return; }
        }
      } finally {
        backgroundPollsInFlight.delete(cacheKey);
      }
    })();
  }
  return null;
}

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
  torbox: torboxResolve,
  alldebrid: allDebridResolve,
};

/**
 * Resolve an NZB URL to a direct HTTPS stream URL via the configured cloud
 * download client. Returns null if not ready in time, if the service rejects
 * the NZB, or if no suitable video file was extracted.
 */
export async function resolveNzbViaDebrid(config, nzbUrl, title) {
  const client = config.downloadClient;
  const resolver = RESOLVERS[client];
  if (!resolver || !nzbUrl) return null;

  const cacheKey = `nzbcloud:${client}:${nzbUrl}`;
  return resolveCache.memoize(
    cacheKey,
    () => resolver(config, nzbUrl, title).catch(() => null),
    { pickTtl: (v) => (v ? CACHE_TTL_OK : CACHE_TTL_FAIL) },
  );
}
