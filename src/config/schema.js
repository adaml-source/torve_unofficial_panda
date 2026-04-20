export const QUALITY_OPTIONS = ["2160p", "1080p", "720p", "480p"];
export const QUALITY_PROFILES = [
  "balanced",
  "best_quality",
  "fast_start",
  "data_saver"
];
export const DEBRID_SERVICES = [
  "none",
  "realdebrid",
  "premiumize",
  "alldebrid",
  "debridlink",
  "easydebrid",
  "offcloud",
  "torbox",
  "putio"
];
export const RELEASE_LANGUAGES = [
  "any",
  "english",
  "german",
  "spanish",
  "italian",
  "french",
  "portuguese",
  "turkish",
  "japanese",
  "korean",
  "chinese",
  "hindi",
  "multi"
];
export const SORT_OPTIONS = ["quality", "qualitysize", "seeders", "size"];
export const RESULT_LIMITS = ["5", "10", "15", "20"];

export const USENET_PROVIDERS = ["none", "easynews", "generic"];
export const NZB_INDEXERS = ["none", "nzbgeek", "scenenzbs", "dognzb", "nzbplanet", "custom"];
// Local download clients (nzbget/sabnzbd) write files to disk on the host
// they run on. Cloud clients (premiumize/torbox/alldebrid) download on the
// provider's infrastructure and return streaming URLs, so Panda writes
// nothing locally — the NZB path behaves like a debrid-backed stream.
export const DOWNLOAD_CLIENTS = ["none", "nzbget", "sabnzbd", "premiumize", "torbox", "alldebrid"];
export const DOWNLOAD_CLIENT_IS_CLOUD = new Set(["premiumize", "torbox", "alldebrid"]);

const DEFAULT_PROVIDER_IDS = [
  "yts",
  "eztv",
  "1337x",
  "thepiratebay",
  "torrentgalaxy",
  "nyaasi"
];

function sanitizeInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function createDefaultConfig() {
  return {
    version: 2,
    enabledProviders: DEFAULT_PROVIDER_IDS,
    qualityProfile: "balanced",
    maxQuality: "2160p",
    releaseLanguage: "any",       // legacy single-value field, kept for back-compat
    releaseLanguages: ["any"],    // preferred: list of audio-languages to allow
    debridService: "none",
    debridApiKey: "",
    debridCredentialCiphertext: "",   // v1 encrypted token (preferred over debridApiKey)
    debridCredentialSource: "",       // "oauth" | "apikey" | ""
    debridDisplayIdentifier: "",      // e.g. username for UI (no secret)
    putioClientId: "",
    groupByQuality: true,
    sortTorrentsBy: "qualitysize",
    allowUncached: false,
    maxResults: "10",
    hideDownloadLinks: true,
    hideCatalog: true,
    // Usenet
    enableUsenet: false,
    usenetProvider: "none",
    usenetHost: "",
    usenetPort: 563,
    usenetUsername: "",
    usenetPassword: "",
    usenetSSL: true,
    usenetConnections: 10,
    nzbIndexer: "none",        // legacy single-indexer field; first item of nzbIndexers
    nzbIndexerUrl: "",         // legacy — custom URL for the legacy indexer slot
    nzbIndexerApiKey: "",      // legacy — api key for the legacy indexer slot
    nzbIndexers: [],           // preferred: [{ type, url, apiKey }] — searched in parallel, results merged
    easynewsPreferNzb: false,  // bandwidth saver: if a NZB indexer + cloud debrid both have the same file, drop Easynews direct stream
    downloadClient: "none",
    downloadClientUrl: "",
    downloadClientUsername: "",
    downloadClientPassword: "",
    downloadClientApiKey: "",
  };
}

function sanitizeStringArray(values, allowedValues) {
  if (!Array.isArray(values)) {
    return [];
  }

  const allowed = new Set(allowedValues);
  return [...new Set(values.filter((value) => allowed.has(value)))];
}

function sanitizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizeConfig(input, knownProviders) {
  const defaults = createDefaultConfig();
  const providerIds = knownProviders.map((provider) => provider.id);
  const enabledProviders = sanitizeStringArray(input?.enabledProviders, providerIds);

  return {
    version: 2,
    enabledProviders: enabledProviders.length > 0 ? enabledProviders : defaults.enabledProviders,
    qualityProfile: QUALITY_PROFILES.includes(input?.qualityProfile)
      ? input.qualityProfile
      : defaults.qualityProfile,
    maxQuality: QUALITY_OPTIONS.includes(input?.maxQuality)
      ? input.maxQuality
      : defaults.maxQuality,
    releaseLanguage: RELEASE_LANGUAGES.includes(input?.releaseLanguage)
      ? input.releaseLanguage
      : defaults.releaseLanguage,
    // releaseLanguages: read preferred array; if missing, fall back to the
    // legacy releaseLanguage scalar so an older config upgrades cleanly.
    // ["any"] and [] both mean "no language filter".
    releaseLanguages: (() => {
      const arr = sanitizeStringArray(input?.releaseLanguages, RELEASE_LANGUAGES);
      if (arr.length > 0) {
        // If "any" is in the list, collapse to just ["any"] — the UI toggle
        // should enforce this, but defend in depth.
        return arr.includes("any") ? ["any"] : arr;
      }
      const legacy = RELEASE_LANGUAGES.includes(input?.releaseLanguage)
        ? input.releaseLanguage
        : defaults.releaseLanguage;
      return [legacy];
    })(),
    debridService: DEBRID_SERVICES.includes(input?.debridService)
      ? input.debridService
      : defaults.debridService,
    debridApiKey: sanitizeString(input?.debridApiKey),
    debridCredentialCiphertext: typeof input?.debridCredentialCiphertext === "string" ? input.debridCredentialCiphertext : "",
    debridCredentialSource: typeof input?.debridCredentialSource === "string" ? input.debridCredentialSource : "",
    debridDisplayIdentifier: sanitizeString(input?.debridDisplayIdentifier),
    putioClientId: sanitizeString(input?.putioClientId),
    groupByQuality: sanitizeBoolean(input?.groupByQuality, defaults.groupByQuality),
    sortTorrentsBy: SORT_OPTIONS.includes(input?.sortTorrentsBy)
      ? input.sortTorrentsBy
      : defaults.sortTorrentsBy,
    allowUncached: sanitizeBoolean(input?.allowUncached, defaults.allowUncached),
    maxResults: RESULT_LIMITS.includes(String(input?.maxResults))
      ? String(input.maxResults)
      : defaults.maxResults,
    hideDownloadLinks: sanitizeBoolean(input?.hideDownloadLinks, defaults.hideDownloadLinks),
    hideCatalog: sanitizeBoolean(input?.hideCatalog, defaults.hideCatalog),
    // Usenet
    enableUsenet: sanitizeBoolean(input?.enableUsenet, defaults.enableUsenet),
    usenetProvider: USENET_PROVIDERS.includes(input?.usenetProvider)
      ? input.usenetProvider
      : defaults.usenetProvider,
    usenetHost: sanitizeString(input?.usenetHost),
    usenetPort: sanitizeInt(input?.usenetPort, 1, 65535, defaults.usenetPort),
    usenetUsername: sanitizeString(input?.usenetUsername),
    usenetPassword: sanitizeString(input?.usenetPassword),
    usenetSSL: sanitizeBoolean(input?.usenetSSL, defaults.usenetSSL),
    usenetConnections: sanitizeInt(input?.usenetConnections, 1, 50, defaults.usenetConnections),
    nzbIndexer: NZB_INDEXERS.includes(input?.nzbIndexer)
      ? input.nzbIndexer
      : defaults.nzbIndexer,
    nzbIndexerUrl: sanitizeString(input?.nzbIndexerUrl),
    nzbIndexerApiKey: sanitizeString(input?.nzbIndexerApiKey),
    // Multi-indexer array. Each entry: { type, url, apiKey }. url is only
    // meaningful when type === "custom". Drop rows with type === "none" and
    // rows missing an API key. Fall back to the legacy single-indexer fields
    // when the array is empty, so existing configs upgrade without editing.
    nzbIndexers: (() => {
      const raw = Array.isArray(input?.nzbIndexers) ? input.nzbIndexers : [];
      const cleaned = raw
        .map((r) => r && typeof r === "object"
          ? {
              type: NZB_INDEXERS.includes(r.type) && r.type !== "none" ? r.type : null,
              url: sanitizeString(r.url),
              apiKey: sanitizeString(r.apiKey),
            }
          : null)
        .filter((r) => r && r.type && r.apiKey);
      if (cleaned.length > 0) return cleaned;
      // Legacy upgrade path
      const legacyType = NZB_INDEXERS.includes(input?.nzbIndexer) ? input.nzbIndexer : "none";
      const legacyKey = sanitizeString(input?.nzbIndexerApiKey);
      if (legacyType !== "none" && legacyKey) {
        return [{ type: legacyType, url: sanitizeString(input?.nzbIndexerUrl), apiKey: legacyKey }];
      }
      return [];
    })(),
    easynewsPreferNzb: sanitizeBoolean(input?.easynewsPreferNzb, defaults.easynewsPreferNzb),
    downloadClient: DOWNLOAD_CLIENTS.includes(input?.downloadClient)
      ? input.downloadClient
      : defaults.downloadClient,
    downloadClientUrl: sanitizeString(input?.downloadClientUrl),
    downloadClientUsername: sanitizeString(input?.downloadClientUsername),
    downloadClientPassword: sanitizeString(input?.downloadClientPassword),
    downloadClientApiKey: sanitizeString(input?.downloadClientApiKey),
  };
}
