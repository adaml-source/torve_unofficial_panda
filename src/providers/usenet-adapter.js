const DEFAULT_TIMEOUT = 15000;

const INDEXER_URLS = {
  nzbgeek: "https://api.nzbgeek.info",
  scenenzbs: "https://scenenzbs.com",
  dognzb: "https://api.dognzb.cr",
  nzbplanet: "https://api.nzbplanet.net",
};

function parseMediaId(mediaId) {
  const parts = mediaId.split(":");
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1], 10) : null,
    episode: parts[2] ? parseInt(parts[2], 10) : null,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

// ── Easynews ──

async function searchEasynews(config, mediaType, mediaId, baseUrl) {
  if (!config.usenetUsername || !config.usenetPassword) return [];

  const { imdbId, season, episode } = parseMediaId(mediaId);
  const imdbNum = imdbId.replace("tt", "");

  // Build search query
  const params = new URLSearchParams({
    sb: "1",
    pby: "20",
    pno: "1",
    sS: "5",
    fex: "mkv,avi,mp4,wmv,mpg,mov",
    s1: "relevance",
    s1d: "-",
    s2: "dsize",
    s2d: "-",
    s3: "dtime",
    s3d: "-",
  });

  // Search by IMDB ID for better accuracy
  params.set("gps", imdbNum);
  if (mediaType === "series" && season != null && episode != null) {
    const se = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    params.set("gps", `${imdbNum} ${se}`);
  }

  const auth = Buffer.from(`${config.usenetUsername}:${config.usenetPassword}`).toString("base64");

  try {
    const response = await fetchWithTimeout(
      `https://members.easynews.com/2.0/search/solr-search/advanced?${params}`,
      { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } },
    );

    const data = await response.json();
    if (!data || !Array.isArray(data.data)) return [];

    return data.data
      .filter((item) => item.rawSize > 0 && item.sig1)
      .slice(0, 15)
      .map((item) => {
        const streamUrl = baseUrl
          ? `${baseUrl}/easynews/${item.sig1}/${encodeURIComponent(item.fileName)}`
          : `https://${config.usenetUsername}:${config.usenetPassword}@members.easynews.com/dl/${item.sig1}/${encodeURIComponent(item.fileName)}`;
        const size = formatFileSize(item.rawSize);
        const codec = item.codec || "";
        const titleParts = [item.fileName, size, codec].filter(Boolean);

        return {
          name: "Easynews",
          title: titleParts.join(" | "),
          url: streamUrl,
          behaviorHints: { notWebReady: false },
        };
      });
  } catch (err) {
    console.error(`Easynews search failed: ${err.message}`);
    return [];
  }
}

// ── Newznab indexer ──

async function searchNewznab(config, mediaType, mediaId) {
  const indexerUrl = config.nzbIndexer === "custom"
    ? config.nzbIndexerUrl
    : INDEXER_URLS[config.nzbIndexer];

  if (!indexerUrl || !config.nzbIndexerApiKey) return [];

  const { imdbId, season, episode } = parseMediaId(mediaId);
  const imdbNum = imdbId.replace("tt", "");

  const params = new URLSearchParams({
    apikey: config.nzbIndexerApiKey,
    o: "json",
    limit: "15",
  });

  if (mediaType === "movie") {
    params.set("t", "movie");
    params.set("imdbid", imdbNum);
  } else {
    params.set("t", "tvsearch");
    params.set("imdbid", imdbNum);
    if (season != null) params.set("season", String(season));
    if (episode != null) params.set("ep", String(episode));
  }

  try {
    const baseUrl = indexerUrl.replace(/\/+$/, "");
    const response = await fetchWithTimeout(`${baseUrl}/api?${params}`, {
      headers: { Accept: "application/json" },
    });

    const data = await response.json();

    // Newznab JSON format: { channel: { item: [...] } } or { item: [...] }
    const items = data?.channel?.item || data?.item || [];
    if (!Array.isArray(items)) return [];

    return items.slice(0, 15).map((item) => {
      const title = item.title || "Unknown";
      const nzbUrl = item.link || item.enclosure?.["@attributes"]?.url || "";
      const size = item.enclosure?.["@attributes"]?.length
        ? formatFileSize(Number(item.enclosure["@attributes"].length))
        : "";
      const indexerName = config.nzbIndexer === "custom" ? "NZB" : config.nzbIndexer.toUpperCase();

      return {
        name: `${indexerName} (NZB)`,
        title: [title, size].filter(Boolean).join(" | "),
        url: nzbUrl,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `usenet-nzb-${config.nzbIndexer}`,
        },
      };
    });
  } catch (err) {
    console.error(`Newznab search failed (${config.nzbIndexer}): ${err.message}`);
    return [];
  }
}

// ── Public API ──

export async function fetchUsenetStreams(config, mediaType, mediaId, proxyBaseUrl) {
  if (!config.enableUsenet) return [];

  const sources = [];

  if (config.usenetProvider === "easynews") {
    sources.push(
      searchEasynews(config, mediaType, mediaId, proxyBaseUrl).catch((err) => {
        console.error(`Easynews adapter error: ${err.message}`);
        return [];
      }),
    );
  }

  if (config.nzbIndexer !== "none") {
    sources.push(
      searchNewznab(config, mediaType, mediaId).catch((err) => {
        console.error(`Newznab adapter error: ${err.message}`);
        return [];
      }),
    );
  }

  if (sources.length === 0) return [];

  const results = await Promise.all(sources);
  return results.flat();
}
