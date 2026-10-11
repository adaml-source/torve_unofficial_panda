// Reject contradictions before presenting a source. A title query is not an identity check.
export function normalizeImdb(value) {
  const match = String(value || "").match(/^(?:tt)?(\d+)$/) || String(value || "").match(/imdb\.com\/title\/tt(\d+)/i);
  return match ? String(Number(match[1])) : null;
}

export function matchesUsenetIdentity(item, requested) {
  const expectedImdb = normalizeImdb(requested.imdbId);
  const actualImdb = normalizeImdb(item.imdbId);
  if (actualImdb && expectedImdb && actualImdb !== expectedImdb) return false;

  const name = String(item.title || "");
  const episodeMarker = /\bS(\d{1,2})[ ._-]*E(\d{1,3})(?:[ ._-]*E(\d{1,3}))?/i.exec(name) ||
    /\b(\d{1,2})x(\d{1,3})\b/i.exec(name);
  if (requested.mediaType === "series") {
    if (episodeMarker && requested.season != null && Number(episodeMarker[1]) !== requested.season) return false;
    if (episodeMarker && requested.episode != null &&
        !episodeMarker.slice(2).filter(Boolean).map(Number).includes(requested.episode)) return false;
    const number = (value) => /^[SE]?\d+$/i.test(String(value || "")) ? Number(String(value).replace(/^[SE]/i, "")) : null;
    const season = number(item.season), episode = number(item.episode);
    if (season != null && requested.season != null && season !== requested.season) return false;
    if (episode != null && requested.episode != null && episode !== requested.episode) return false;
  }

  // Only a year in the series/movie title prefix identifies a remake. Dates in
  // episode titles, release groups, and air-date metadata are not series years.
  const prefix = episodeMarker ? name.slice(0, episodeMarker.index) : name.split(/\b(?:2160p|1080p|720p|480p|WEB|BluRay)\b/i)[0];
  const releaseYear = /(?:^|[ ._([])((?:19|20)\d{2})(?=$|[ ._)\]-])/.exec(prefix)?.[1];
  const expectedYear = /(?:19|20)\d{2}/.exec(String(requested.year || ""))?.[0];
  if (releaseYear && expectedYear && releaseYear !== expectedYear) return false;

  // An ID-scoped Newznab search can still return yearless releases. Keep those
  // when no explicit contradiction exists; never invent a year from an air date.
  return true;
}
