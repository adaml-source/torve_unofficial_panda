import { TtlCache } from "../lib/ttl-cache.js";

// Shared cache for upstream query responses. Keyed per-user so one user's
// auth failure doesn't poison another user's results.
const searchCache = new TtlCache({ maxEntries: 2000 });
const CACHE_TTL_HIT = 30 * 60 * 1000;   // 30 min for non-empty results
const CACHE_TTL_MISS = 5 * 60 * 1000;   // 5 min for empty (may recover soon)

const DEFAULT_TIMEOUT = 10000;
// Easynews solr search typically runs 8-14s. Keep this just under the
// pipeline budget (14s) so a slow Easynews call still lets SCENENZBS
// results make it out.
const EASYNEWS_TIMEOUT = 13000;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

/**
 * Look up a title from Cinemeta (Stremio's public metadata service).
 * Always returns the English title. Use fetchLocalizedTitles for i18n.
 */
async function fetchMediaTitle(mediaType, mediaId) {
  try {
    const type = mediaType === "series" ? "series" : "movie";
    const imdbId = mediaId.split(":")[0];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { signal: ctrl.signal, headers: { accept: "application/json" } }
    ).finally(() => clearTimeout(t));
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.meta;
    if (!meta?.name) return null;
    return { name: meta.name, year: meta.year || meta.releaseInfo || null };
  } catch {
    return null;
  }
}

// Map Panda's config.releaseLanguage values to ISO 639-1 codes used by Wikidata.
const LANG_CODE_MAP = {
  english: "en",
  german: "de",
  spanish: "es",
  italian: "it",
  french: "fr",
  portuguese: "pt",
  turkish: "tr",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  hindi: "hi",
};

// Easynews tags audio/subtitle tracks using ISO 639-2 (bibliographic) codes,
// which differ from the 639-1 codes used everywhere else. Also maps to the
// English-language keyword Easynews indexes in filenames (".german.", ".fre.")
// so we can nudge the solr search towards dubbed releases.
const LANG_EZ_MAP = {
  en: { tag: "eng", keyword: "english" },
  de: { tag: "ger", keyword: "german" },
  es: { tag: "spa", keyword: "spanish" },
  it: { tag: "ita", keyword: "italian" },
  fr: { tag: "fre", keyword: "french" },
  pt: { tag: "por", keyword: "portuguese" },
  tr: { tag: "tur", keyword: "turkish" },
  ja: { tag: "jpn", keyword: "japanese" },
  ko: { tag: "kor", keyword: "korean" },
  zh: { tag: "chi", keyword: "chinese" },
  hi: { tag: "hin", keyword: "hindi" },
};

/**
 * Fetch localized titles from Wikidata for an IMDb ID.
 * Free, no API key. Returns { [lang]: title } for the requested languages.
 */
async function fetchLocalizedTitles(imdbId, wantLangs) {
  const cleanId = imdbId.replace(/^tt/, "");
  if (!wantLangs || wantLangs.length === 0) return {};
  try {
    const filter = wantLangs.map(l => `"${l}"`).join(",");
    const sparql = `SELECT ?label ?lang WHERE {
      ?item wdt:P345 "tt${cleanId}" .
      ?item rdfs:label ?label .
      BIND(LANG(?label) AS ?lang)
      FILTER(?lang IN (${filter}))
    }`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept": "application/sparql-results+json",
        "user-agent": "Torve-Panda/1.0 (https://panda.torve.app)",
      },
      body: "query=" + encodeURIComponent(sparql),
    }).finally(() => clearTimeout(t));
    if (!res.ok) return {};
    const data = await res.json();
    const out = {};
    for (const row of data?.results?.bindings || []) {
      const lang = row.lang?.value;
      const label = row.label?.value;
      if (lang && label && !out[lang]) out[lang] = label;
    }
    return out;
  } catch {
    return {};
  }
}

// Normalize a filename or title into tokens for relevance matching.
// Splits on anything non-alphanumeric and lowercases.
function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Short/common words that don't add meaning when checking relevance. If a
// title is just these (e.g. "The It"), we fall through and require ALL tokens.
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "and", "to", "in", "on", "at", "for", "with", "by",
  "der", "die", "das", "den", "ein", "eine", "und", "im", "am", "zu",
]);

/**
 * Drop results whose filenames don't contain the main title keywords, and
 * (optionally) whose audio tracks don't include the user's preferred language.
 *
 * Title-relevance: guards against Easynews's fuzzy `gps` returning unrelated
 *   content. Rule: at least one non-stop-word title token must appear in the
 *   filename base. If the title is entirely stop-words, require the full title
 *   string (spaces-to-dots) to appear.
 *
 * Language: if `languageTag` is set, keep items whose `alangs` array contains
 *   that tag OR whose filename includes the language keyword (".german.",
 *   ".fre.", etc.) as a fallback for poorly-tagged releases.
 */
function filterByTitleRelevance(items, title, year, languageTag, languageKeyword) {
  const titleTokens = tokenize(title).filter(t => !STOP_WORDS.has(t) && t.length > 1);
  const lowTitle = String(title).toLowerCase().replace(/\s+/g, "[. _-]+");
  const titleRe = titleTokens.length === 0 ? new RegExp(lowTitle) : null;

  return items.filter(item => {
    const name = (item?.["10"] || "").toLowerCase();
    if (!name) return false;

    const titleOk = titleRe
      ? titleRe.test(name)
      : titleTokens.some(t => name.includes(t));
    if (!titleOk) return false;

    if (languageTag) {
      const alangs = Array.isArray(item.alangs) ? item.alangs : [];
      const hasLangTag = alangs.includes(languageTag);
      const hasLangKeyword = languageKeyword && name.includes(languageKeyword);
      // Non-English requests are strict: require an explicit audio tag or
      // filename marker. English requests accept untagged releases (the vast
      // majority of untagged scene releases are English by default).
      if (languageTag === "eng") {
        if (alangs.length > 0 && !hasLangTag && !hasLangKeyword) return false;
      } else {
        if (!hasLangTag && !hasLangKeyword) return false;
      }
    }
    return true;
  });
}

/**
 * Resolve an Easynews /dl/<sig>/<filename> URL to its actual signed CDN URL
 * by following the 302. The CDN URL contains a `?sig=...` token that both
 * authenticates the request and targets the specific backend node that has
 * the file prepared — so the player sees ~125ms time-to-first-byte instead
 * of the ~100s cold-start on the canonical /dl/ endpoint.
 *
 * Cached in `searchCache` under a separate key-space so repeat opens of the
 * same title don't re-pay the 350ms redirect latency.
 */
async function resolveEasynewsCdnUrl(sig, fileName, config) {
  const cacheKey = `ezcdn:${sig}`;
  return searchCache.memoize(
    cacheKey,
    async () => {
      const auth = Buffer.from(`${config.usenetUsername}:${config.usenetPassword}`).toString("base64");
      const canonical = `https://members.easynews.com/dl/${sig}/${encodeURIComponent(fileName)}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetch(canonical, {
          method: "HEAD",
          headers: { Authorization: `Basic ${auth}` },
          redirect: "manual",
          signal: controller.signal,
        });
        let loc = res.headers.get("location");
        if (!loc) return null;
        // Strip default ports — Easynews issues URLs like
        // `https://ams-dl-01.easynews.com:443/...` which some HTTP clients
        // (notably ktor on Android) reject as malformed. Normalising matches
        // the form returned by Easynews's web UI.
        loc = loc.replace(/^(https):\/\/([^/]+):443\//, "$1://$2/");
        loc = loc.replace(/^(http):\/\/([^/]+):80\//, "$1://$2/");
        return loc;
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    },
    // CDN sig tokens are valid for days; cache long. Null (lookup failed)
    // expires quickly so we retry next request.
    { pickTtl: (v) => (v ? CACHE_TTL_HIT : CACHE_TTL_MISS) },
  );
}

/**
 * Fire-and-forget small-Range GET to warm a resolved Easynews CDN URL.
 * Easynews's CDN has a long cold-start (~100s TTFB) on first touch of a
 * file — but once any byte is served, the file stays warm on that node for
 * subsequent requests. Firing this at search time means the player's actual
 * playback request (a few seconds later) finds a hot file.
 *
 * Deduplicated via `searchCache` so we don't re-warm the same URL on every
 * detail-page reload.
 */
function warmEasynewsCdn(cdnUrl) {
  const cacheKey = `ezwarm:${cdnUrl}`;
  if (searchCache.get(cacheKey)) return;
  searchCache.set(cacheKey, true, CACHE_TTL_HIT);

  const controller = new AbortController();
  // 2 minutes is enough to cover even the worst cold-start we've seen (~100s).
  // We discard the response body; we just need Easynews's side to do the work.
  setTimeout(() => controller.abort(), 120000);
  fetch(cdnUrl, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
    signal: controller.signal,
  })
    .then((res) => { try { res.body?.cancel(); } catch {} })
    .catch(() => {});
}

/**
 * Look up a previously-resolved CDN URL for a signature. Used by the Panda
 * proxy to skip the /dl/ 302 hop when it has a cached target. Returns null
 * if no warm target is available (caller falls back to canonical /dl/ URL).
 */
export function getCachedEasynewsCdnUrl(sig) {
  return searchCache.get(`ezcdn:${sig}`) || null;
}

async function easynewsQuery(gpsValue, config) {
  const cacheKey = `ez:${config.usenetUsername}:${gpsValue}`;
  return searchCache.memoize(
    cacheKey,
    async () => {
      const params = new URLSearchParams({
        sb: "1", pby: "20", pno: "1", sS: "5",
        fex: "mkv,avi,mp4,wmv,mpg,mov",
        s1: "relevance", s1d: "-",
        s2: "dsize", s2d: "-",
        s3: "dtime", s3d: "-",
        gps: gpsValue,
      });
      const auth = Buffer.from(`${config.usenetUsername}:${config.usenetPassword}`).toString("base64");
      const response = await fetchWithTimeout(
        `https://members.easynews.com/2.0/search/solr-search/advanced?${params}`,
        { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } },
        EASYNEWS_TIMEOUT,
      );
      const data = await response.json();
      return Array.isArray(data?.data) ? data.data : [];
    },
    { pickTtl: (v) => (v.length > 0 ? CACHE_TTL_HIT : CACHE_TTL_MISS) },
  );
}

async function searchEasynews(config, mediaType, mediaId, baseUrl) {
  if (!config.usenetUsername || !config.usenetPassword) return [];

  const { imdbId, season, episode } = parseMediaId(mediaId);
  const imdbNum = imdbId.replace("tt", "");
  const seSuffix = (mediaType === "series" && season != null && episode != null)
    ? ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
    : "";

  // Strategy: title-based serial search with early exit.
  //
  // We skip the IMDB-number search even though Easynews accepts it: their `gps`
  // parameter does a fuzzy full-text match, and numeric IDs collide with
  // unrelated files (file hashes, size fields). Example: gps=8036976 ("Send
  // Help") returned four random unrelated files. Title+year is both faster
  // (serial, 1-2s) and dramatically more accurate.
  //
  //   1. Localized title+year  (non-English users)  → return if hits
  //   2. English title+year                         → return if hits
  //
  // Results are then passed through a filename relevance filter so a broken
  // search (e.g. user types a title that matches thousands of junk files)
  // still returns zero rather than garbage.
  const langKey = String(config.releaseLanguage || "any").toLowerCase();
  const langCode = LANG_CODE_MAP[langKey];
  const wantLocalized = langCode && langCode !== "en";
  const ezLang = langCode ? LANG_EZ_MAP[langCode] : null;
  // No language filter when user picked "any"
  const filterTag = ezLang?.tag || null;
  const filterKeyword = ezLang?.keyword || null;

  const [metaResult, localizedResult] = await Promise.all([
    fetchMediaTitle(mediaType, mediaId).catch(() => null),
    wantLocalized ? fetchLocalizedTitles(imdbId, [langCode]).catch(() => ({})) : Promise.resolve({}),
  ]);
  const year = metaResult?.year ? String(metaResult.year).match(/\d{4}/)?.[0] : null;

  // Append language keyword to localized/non-English searches. For English,
  // leave the query clean (scene releases rarely label .english. in filenames).
  const buildGps = (title, includeLangKeyword) => {
    const parts = [title];
    if (year) parts.push(year);
    if (seSuffix) parts.push(seSuffix.trim());
    if (includeLangKeyword && filterKeyword && filterKeyword !== "english") {
      parts.push(filterKeyword);
    }
    return parts.join(" ");
  };

  const tryQuery = async (label, title, includeLangKeyword) => {
    if (!title) return [];
    try {
      const batch = await easynewsQuery(buildGps(title, includeLangKeyword), config);
      const filtered = Array.isArray(batch)
        ? filterByTitleRelevance(batch, title, year, filterTag, filterKeyword)
        : [];
      return filtered;
    } catch (err) {
      console.error(`Easynews ${label} search failed: ${err.message}`);
      return [];
    }
  };

  const localizedTitle = wantLocalized ? localizedResult?.[langCode] : null;
  let rawItems = [];

  if (localizedTitle) {
    console.log(`Easynews localized search: ${localizedTitle} (${langCode}) year=${year}`);
    // Localized title + language keyword: maximum signal for dubbed releases
    rawItems = await tryQuery("localized title", localizedTitle, true);
  }

  if (rawItems.length === 0 && metaResult?.name && metaResult.name !== localizedTitle) {
    // English-title fallback: still ask Easynews for the localized audio so
    // German users who open a movie with no German-language metadata still
    // get a dubbed release if it was posted under the English name.
    rawItems = await tryQuery("english title", metaResult.name, wantLocalized);
  }

  try {
    const data = { data: rawItems };
    if (!data || !Array.isArray(data.data)) return [];

    // Easynews returns each result with numeric-indexed fields:
    //   "0"  = signature (used in /dl/<sig>/ URL)
    //   "2"  = file extension (e.g. ".mkv")
    //   "10" = filename base (without extension)
    //   "11" = filename extension (duplicate of 2 with dot)
    //   "12" = video codec
    //   top-level: rawSize (bytes), passwd (bool), virus (bool), fullres, alangs
    const kept = data.data
      .filter((item) => {
        const sig = item["0"];
        const name = item["10"];
        const ext = item["11"] || item["2"] || "";
        return (
          item.rawSize > 0 &&
          typeof sig === "string" && sig &&
          typeof name === "string" && name &&
          !item.passwd &&
          !item.virus &&
          /\.(mkv|mp4|avi|mov|m4v|ts|wmv|mpg|mpeg)$/i.test(ext)
        );
      })
      .slice(0, 15);

    // We can't return the direct CDN URL to the Torve app: it routes any
    // non-Panda stream through RealDebrid's unrestrict endpoint, which rejects
    // Easynews hosts and reports "no playable URL". So we return the
    // Panda-domain proxy URL (which Torve plays directly) and do the CDN-warm
    // work in the background: resolve + fire a small Range probe so Easynews
    // prepares the file BEFORE the player clicks play. When the player then
    // hits the Panda proxy, the upstream fetch finds a warm CDN node and
    // serves bytes in ~100ms instead of the 100s cold-start.
    await Promise.all(
      kept.map(async (item) => {
        const sig = item["0"];
        const base = item["10"];
        const ext = item["11"] || item["2"] || "";
        const fileName = `${base}${ext}`;
        const cdnUrl = await resolveEasynewsCdnUrl(sig, fileName, config).catch(() => null);
        if (cdnUrl) warmEasynewsCdn(cdnUrl);
      }),
    );

    return kept.map((item) => {
      const sig = item["0"];
      const base = item["10"];
      const ext = item["11"] || item["2"] || "";
      const fileName = `${base}${ext}`;
      const streamUrl = baseUrl
        ? `${baseUrl}/easynews/${sig}/${encodeURIComponent(fileName)}`
        : `https://${config.usenetUsername}:${config.usenetPassword}@members.easynews.com/dl/${sig}/${encodeURIComponent(fileName)}`;
      const size = formatFileSize(item.rawSize);
      const codec = item["12"] || "";
      const resolution = item.fullres || "";

      // Detect resolution label for the name (same convention Torrentio uses)
      const height = parseInt(item.height, 10) || 0;
      let qualityLabel = "";
      if (height >= 2000) qualityLabel = "4k";
      else if (height >= 1000) qualityLabel = "1080p";
      else if (height >= 600) qualityLabel = "720p";
      else if (height >= 400) qualityLabel = "480p";

      return {
        // Torrentio-style name: addon newline quality
        name: qualityLabel ? `Easynews\n${qualityLabel}` : "Easynews",
        // Torrentio-style title: filename newline metadata row
        title: `${fileName}\n📺 ${resolution} 💾 ${size} ⚙️ ${codec || "-"}`,
        url: streamUrl,
        behaviorHints: {
          // Keep these explicit — the Torve Android app uses them to decide
          // between in-app ExoPlayer playback (good for HTTPS URLs, handles
          // Range correctly) and an ACTION_VIEW intent chooser (which may
          // hand the URL to Samsung Video Player, which rejects HTTPS with
          // "No content provider"). notWebReady=false + proxyHeaders present
          // signals "web-ready stream, play in-app".
          notWebReady: false,
          bingeGroup: `easynews${qualityLabel ? "-" + qualityLabel : ""}`,
          filename: fileName,
          videoSize: item.rawSize,
          proxyHeaders: {
            request: {},
            response: {},
          },
        },
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
    const cacheKey = `nzb:${config.nzbIndexer}:${config.nzbIndexerApiKey.slice(0, 8)}:${mediaType}:${mediaId}`;
    const items = await searchCache.memoize(
      cacheKey,
      async () => {
        const response = await fetchWithTimeout(`${baseUrl}/api?${params}`, {
          headers: { Accept: "application/json" },
        });
        const data = await response.json();
        const raw = data?.channel?.item || data?.item || [];
        return Array.isArray(raw) ? raw : [];
      },
      { pickTtl: (v) => (v.length > 0 ? CACHE_TTL_HIT : CACHE_TTL_MISS) },
    );

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
