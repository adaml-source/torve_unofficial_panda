const TORRENTIO_BASE_URL = (process.env.TORRENTIO_BASE_URL || "https://torrentio.strem.fun").replace(/\/+$/, "");

const QUALITY_EXCLUDES_BY_MAX = {
  "2160p": [],
  "1080p": ["4k"],
  "720p": ["4k", "1080p"],
  "480p": ["4k", "1080p", "720p"]
};

const PROFILE_EXCLUDES = {
  balanced: ["cam", "scr", "unknown"],
  best_quality: ["cam", "scr", "unknown", "480p"],
  fast_start: ["cam", "scr", "unknown", "brremux"],
  data_saver: ["cam", "scr", "unknown", "brremux", "hdrall", "dolbyvision", "dolbyvisionwithhdr"]
};

const DEBRID_SEGMENT_BY_SERVICE = {
  realdebrid: "realdebrid",
  premiumize: "premiumize",
  alldebrid: "alldebrid",
  debridlink: "debridlink",
  easydebrid: "easydebrid",
  offcloud: "offcloud",
  torbox: "torbox",
  putio: "putio"
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function createDebridCredential(config) {
  // Prefer encrypted credential; fall back to legacy plaintext apikey for
  // existing configs created before encryption was added.
  let secret = config.debridApiKey || null;
  if (config.debridCredentialCiphertext) {
    try {
      const { decryptSecret } = await import("../lib/crypto.js");
      secret = await decryptSecret(config.debridCredentialCiphertext);
    } catch {
      secret = config.debridApiKey || null;
    }
  }

  if (config.debridService === "putio") {
    if (!config.putioClientId || !secret) return null;
    return `${config.putioClientId}@${secret}`;
  }

  return secret || null;
}

async function buildConfigPath(config) {
  const segments = [];
  const providers = unique(config.enabledProviders);

  if (providers.length > 0) {
    segments.push(`providers=${providers.join(",")}`);
  }

  if (config.sortTorrentsBy) {
    segments.push(`sort=${config.sortTorrentsBy}`);
  }

  if (config.releaseLanguage && config.releaseLanguage !== "any") {
    segments.push(`language=${config.releaseLanguage}`);
  }

  const qualityFilters = unique([
    ...(PROFILE_EXCLUDES[config.qualityProfile] || PROFILE_EXCLUDES.balanced),
    ...(QUALITY_EXCLUDES_BY_MAX[config.maxQuality] || [])
  ]);
  if (qualityFilters.length > 0) {
    segments.push(`qualityfilter=${qualityFilters.join(",")}`);
  }

  if (config.maxResults) {
    segments.push(`limit=${config.maxResults}`);
  }

  const debridOptions = [];
  if (config.hideDownloadLinks) {
    debridOptions.push("nodownloadlinks");
  }
  if (config.hideCatalog) {
    debridOptions.push("nocatalog");
  }
  if (debridOptions.length > 0) {
    segments.push(`debridoptions=${debridOptions.join(",")}`);
  }

  const debridSegment = DEBRID_SEGMENT_BY_SERVICE[config.debridService];
  const debridCredential = await createDebridCredential(config);
  if (debridSegment && debridCredential) {
    segments.push(`${debridSegment}=${encodeURIComponent(debridCredential)}`);
  }

  return segments.join("|");
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Torrentio upstream returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildTorrentioStreamUrl(config, mediaType, mediaId) {
  const configPath = await buildConfigPath(config);
  return `${TORRENTIO_BASE_URL}/${configPath}/stream/${mediaType}/${encodeURIComponent(mediaId)}.json`;
}

export async function fetchTorrentioStreams(config, mediaType, mediaId) {
  const url = await buildTorrentioStreamUrl(config, mediaType, mediaId);
  const data = await fetchJson(url);
  return Array.isArray(data?.streams) ? data.streams : [];
}
