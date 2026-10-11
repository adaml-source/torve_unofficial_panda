import { XMLParser } from "fast-xml-parser";

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", attributesGroupName: "@attributes", parseTagValue: false });
const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value) => typeof value === "string" ? value : typeof value === "number" ? String(value) : value?.["#text"] || "";

export async function readNewznabResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Indexer response is empty");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("Indexer response is too large");
      chunks.push(value);
    }
    return parseNewznabResponse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Normalize both documented Newznab formats without merging audio and subtitles. */
export function parseNewznabResponse(body) {
  if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) throw new Error("Indexer response is too large");
  const trimmed = body.trim();
  let data;
  if (trimmed.startsWith("{")) data = JSON.parse(trimmed);
  else {
    if (/<!DOCTYPE|<!ENTITY/i.test(trimmed) || !/<(?:rss|error)(?:\s|>)/i.test(trimmed)) {
      throw new Error("Indexer did not return Newznab JSON or RSS/XML");
    }
    data = xml.parse(trimmed);
  }
  if (data?.error) throw new Error("Indexer rejected the search; check its API key and search access");
  const channel = data?.rss?.channel ?? data?.channel;
  if (!channel && !Object.hasOwn(data, "item")) throw new Error("Indexer search response is not recognized");
  return list(channel?.item ?? data?.item).filter((item) => text(item?.title)).map((item) => {
    const attributes = Object.fromEntries(list(item["newznab:attr"] ?? item.attr).map((attribute) => {
      const values = attribute["@attributes"] ?? attribute;
      return [values.name, text(values.value)];
    }));
    const enclosure = item.enclosure?.["@attributes"] ?? item.enclosure ?? {};
    return {
      title: text(item.title),
      link: text(item.link) || text(enclosure.url),
      enclosure: { "@attributes": { url: text(enclosure.url), length: text(enclosure.length) || attributes.size || "" } },
      language: text(item.language) || attributes.language || "",
      subs: text(item.subs) || attributes.subs || "",
      imdbId: text(item.imdbid) || text(item.imdb) || attributes.imdbid || attributes.imdb || "",
      season: text(item.season) || attributes.season || "",
      episode: text(item.episode) || text(item.ep) || attributes.episode || attributes.ep || "",
    };
  });
}
