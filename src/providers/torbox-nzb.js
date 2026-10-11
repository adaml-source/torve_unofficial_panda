import { createHash } from "node:crypto";

/** Safe for the client: never contains upstream response text, credentials or URLs. */
export class NzbCloudError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const NZB_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO = /\.(mkv|mp4|avi|mov|m4v|ts|wmv|mpg|mpeg)$/i;
const episode = value => /\bS(\d{1,3})[ ._-]*E(\d{1,4})\b/i.exec(value || "");

function bestVideo(files, title) {
  const videos = files.filter(f => VIDEO.test(f.name) && !/\bsample\b/i.test(f.name));
  const requested = episode(title);
  const matching = requested ? videos.filter(f => {
    const found = episode(f.name);
    return found && Number(found[1]) === Number(requested[1]) && Number(found[2]) === Number(requested[2]);
  }) : [];
  if (requested && !matching.length && videos.some(f => episode(f.name))) {
    throw new NzbCloudError("nzb_episode_missing", "The download does not contain this episode. Choose another source.", 422);
  }
  return (matching.length ? matching : videos).sort((a, b) => b.size - a.size)[0];
}

/** One submission per account/source. Subsequent probes poll its existing download. */
export class TorboxNzbResolver {
  constructor({ fetchImpl = (...args) => fetch(...args), now = Date.now, requestWaitMs = 1500, pollIntervalMs = 5000 } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.requestWaitMs = requestWaitMs;
    this.pollIntervalMs = pollIntervalMs;
    this.jobs = new Map();
  }

  async request(url, options = {}, timeoutMs = 8000, indexer = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new NzbCloudError(indexer ? "nzb_access_denied" : "download_client_auth",
            indexer ? "The indexer refused this NZB download. Check its API key and download access, or choose another source."
              : "TorBox refused this request. Check its API key and Usenet access.", 403);
        }
        if (response.status === 429) throw new NzbCloudError(indexer ? "nzb_rate_limited" : "download_client_rate_limited",
          indexer ? "The indexer's download limit has been reached. Try again later or choose another indexer."
            : "TorBox's request limit has been reached. Try again later.", 429);
        if (indexer && response.status === 404) throw new NzbCloudError("nzb_not_found", "This NZB is no longer available. Choose another source.", 404);
        throw new NzbCloudError(indexer ? "nzb_fetch_failed" : "download_client_unavailable",
          indexer ? "The indexer could not provide this NZB. Try again or choose another source." : "TorBox is unavailable. Try again shortly.");
      }
      if (!indexer) {
        const result = await response.json();
        if (result?.success === false) {
          const code = String(result.error || "").toUpperCase();
          if (/AUTH|TOKEN|API_KEY|PLAN|SUBSCRIPTION/.test(code)) throw new NzbCloudError("download_client_auth", "Check your TorBox API key and Usenet access.", 403);
          if (/LIMIT/.test(code)) throw new NzbCloudError("download_client_limit", "TorBox has reached a download or account limit. Check its download queue.", 429);
          throw new NzbCloudError("download_client_rejected", "TorBox could not prepare this download. Try another source.", 422);
        }
        return result;
      }
      if (Number(response.headers.get("content-length")) > NZB_MAX_BYTES) {
        await response.body?.cancel();
        throw new NzbCloudError("nzb_too_large", "This NZB exceeds the download size limit. Choose another source.", 413);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new NzbCloudError("nzb_invalid", "The indexer returned an empty NZB. Choose another source.", 422);
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > NZB_MAX_BYTES) throw new NzbCloudError("nzb_too_large", "This NZB exceeds the download size limit. Choose another source.", 413);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks);
      if (!/<nzb(?:\s|>)/i.test(bytes.subarray(0, 32768).toString("utf8"))) {
        throw new NzbCloudError("nzb_invalid", "The indexer returned a webpage or an error instead of an NZB. Check its download access.", 422);
      }
      return new Blob([bytes], { type: "application/x-nzb" });
    } catch (error) {
      if (error instanceof NzbCloudError) throw error;
      throw new NzbCloudError(indexer ? "nzb_fetch_failed" : "download_client_unavailable",
        indexer ? "The NZB could not be downloaded from the indexer. Try again or choose another source."
          : "TorBox could not be reached. Try again shortly.");
    } finally { clearTimeout(timer); }
  }

  async advance(job, apiKey, nzbUrl, title) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const api = "https://api.torbox.app/v1/api/usenet";
    if (job.id == null) {
      const nzb = await this.request(nzbUrl, { headers: { "User-Agent": "Panda/1.0 (+https://panda.torve.app)" } }, 30000, true);
      const body = new FormData();
      body.append("file", nzb, "source.nzb");
      if (title) body.append("name", title);
      const created = await this.request(`${api}/createusenetdownload`, { method: "POST", headers, body }, 30000);
      job.id = created?.data?.usenetdownload_id;
      if (job.id == null) throw new NzbCloudError("download_client_rejected", "TorBox did not accept this NZB. Try another source.", 422);
    }
    const status = await this.request(`${api}/mylist?id=${encodeURIComponent(job.id)}`, { headers });
    const download = Array.isArray(status?.data) ? status.data.find(d => String(d.id) === String(job.id)) : status?.data;
    if (!download) return null;
    const state = String(download.download_state || "").toLowerCase();
    if (/failed|error|aborted/.test(state)) throw new NzbCloudError("nzb_download_failed", "TorBox could not complete this NZB download. It may be missing Usenet articles; choose another source.", 422);
    // Finished downloading can still mean repairing/unpacking. Wait for files to become available.
    if (download.download_present === false) return null;
    const ready = download.download_present === true || download.download_finished === true || state === "completed" || state === "cached";
    if (!ready) return null;
    const files = (download.files || []).map(f => ({ name: f.name || f.short_name || "", size: Number(f.size) || 0, id: f.id }));
    if (!files.length) return null;
    const best = bestVideo(files, title);
    if (!best || best.id == null) throw new NzbCloudError("nzb_video_missing", "This download contains no playable video. Choose another source.", 422);
    const link = await this.request(`${api}/requestdl?${new URLSearchParams({ token: apiKey, usenet_id: job.id, file_id: best.id })}`, { headers });
    if (typeof link?.data !== "string" || !/^https?:\/\//i.test(link.data)) throw new NzbCloudError("download_client_link_failed", "TorBox could not provide a playback link. Try again shortly.");
    return { url: link.data, filename: best.name, size: best.size };
  }

  async resolve(config, nzbUrl, title) {
    const apiKey = config.downloadClientApiKey;
    if (!apiKey) throw new NzbCloudError("download_client_auth", "Add your TorBox API key in Panda setup.", 403);
    const requested = episode(title);
    const key = createHash("sha256").update(JSON.stringify([apiKey, nzbUrl, requested?.slice(1).map(Number)])).digest("hex");
    const now = this.now();
    let job = this.jobs.get(key);
    if (!job) {
      // Bound memory without evicting an active submission and creating a duplicate.
      for (const [id, entry] of this.jobs) if (!entry.running && now - entry.used > 2 * 60 * 60 * 1000) this.jobs.delete(id);
      if (this.jobs.size >= 1000) {
        const idle = [...this.jobs].find(([, entry]) => !entry.running);
        if (idle) this.jobs.delete(idle[0]);
        else throw new NzbCloudError("download_client_busy", "Preparation is busy. Try again shortly.", 503);
      }
      job = { used: now, nextPoll: 0, id: null, result: null, error: null, running: null };
      this.jobs.set(key, job);
    }
    job.used = now;
    if (job.result && now < job.readyUntil) return job.result;
    if (!job.running && now >= job.nextPoll) {
      job.error = null;
      job.result = null;
      job.running = this.advance(job, apiKey, nzbUrl, title).then(result => {
        job.result = result;
        job.readyUntil = this.now() + 30 * 60 * 1000;
        job.nextPoll = this.now() + this.pollIntervalMs;
      }).catch(error => {
        job.error = error;
        job.nextPoll = this.now() + 15000;
      }).finally(() => { job.running = null; });
    }
    if (job.running) {
      let timer;
      try { await Promise.race([job.running, new Promise(resolve => { timer = setTimeout(resolve, this.requestWaitMs); })]); }
      finally { clearTimeout(timer); }
    }
    if (job.error) throw job.error;
    return job.result;
  }
}
