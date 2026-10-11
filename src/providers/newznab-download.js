/** Prefer the authenticated NZB enclosure, never the release's web/details page. */
export function newznabDownloadUrl(item, endpoint, apiKey) {
  const api = new URL(endpoint);
  const parse = value => {
    try {
      const result = new URL(String(value).replace(/&amp;/gi, "&"), api);
      return ["http:", "https:"].includes(result.protocol) ? result : null;
    } catch { return null; }
  };
  const enclosure = item.enclosure?.["@attributes"]?.url;
  const link = item.link;
  let url = enclosure ? parse(enclosure) : null;
  if (!url && link) {
    const candidate = parse(link);
    if (candidate && (candidate.searchParams.get("t") === "get" || /(?:\/getnzb\/|\.nzb$)/i.test(candidate.pathname))) url = candidate;
  }
  if (!url && item.guid) {
    const raw = String(item.guid).trim();
    const guid = /^https?:/i.test(raw) ? parse(raw)?.searchParams.get("id") : raw;
    if (guid) { url = new URL(api); url.search = ""; url.searchParams.set("t", "get"); url.searchParams.set("id", guid); }
  }
  if (!url) return null;
  // Keys belong only on this indexer's API. CDN and signed download URLs are preserved.
  if (url.origin === api.origin && /\/api(?:\.php)?\/?$/i.test(url.pathname) && url.searchParams.get("t") === "get") {
    if (!url.searchParams.get("apikey")) url.searchParams.set("apikey", apiKey);
  }
  return url.href;
}
