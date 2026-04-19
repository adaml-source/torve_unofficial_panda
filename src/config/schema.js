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

const DEFAULT_PROVIDER_IDS = [
  "yts",
  "eztv",
  "1337x",
  "thepiratebay",
  "torrentgalaxy",
  "nyaasi"
];

export function createDefaultConfig() {
  return {
    version: 2,
    enabledProviders: DEFAULT_PROVIDER_IDS,
    qualityProfile: "balanced",
    maxQuality: "2160p",
    releaseLanguage: "any",
    debridService: "none",
    debridApiKey: "",
    putioClientId: "",
    groupByQuality: true,
    sortTorrentsBy: "qualitysize",
    allowUncached: false,
    maxResults: "10",
    hideDownloadLinks: true,
    hideCatalog: true
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
    debridService: DEBRID_SERVICES.includes(input?.debridService)
      ? input.debridService
      : defaults.debridService,
    debridApiKey: typeof input?.debridApiKey === "string" ? input.debridApiKey.trim() : "",
    putioClientId: typeof input?.putioClientId === "string" ? input.putioClientId.trim() : "",
    groupByQuality: sanitizeBoolean(input?.groupByQuality, defaults.groupByQuality),
    sortTorrentsBy: SORT_OPTIONS.includes(input?.sortTorrentsBy)
      ? input.sortTorrentsBy
      : defaults.sortTorrentsBy,
    allowUncached: sanitizeBoolean(input?.allowUncached, defaults.allowUncached),
    maxResults: RESULT_LIMITS.includes(String(input?.maxResults))
      ? String(input.maxResults)
      : defaults.maxResults,
    hideDownloadLinks: sanitizeBoolean(input?.hideDownloadLinks, defaults.hideDownloadLinks),
    hideCatalog: sanitizeBoolean(input?.hideCatalog, defaults.hideCatalog)
  };
}
