export const PROVIDER_REGISTRY = [
  {
    id: "yts",
    name: "YTS",
    description: "Fast movie torrents with simple naming and broad availability.",
    category: "movies",
    region: "global"
  },
  {
    id: "eztv",
    name: "EZTV",
    description: "Episode-focused TV torrents with reliable scene-style releases.",
    category: "series",
    region: "global"
  },
  {
    id: "1337x",
    name: "1337x",
    description: "General torrent index with strong movie and series coverage.",
    category: "general",
    region: "global"
  },
  {
    id: "thepiratebay",
    name: "The Pirate Bay",
    description: "Large general torrent index with broad long-tail availability.",
    category: "general",
    region: "global"
  },
  {
    id: "torrentgalaxy",
    name: "TorrentGalaxy",
    description: "Popular general tracker with balanced quality and retention.",
    category: "general",
    region: "global"
  },
  {
    id: "magnetdl",
    name: "MagnetDL",
    description: "Lightweight public index that can help fill harder searches.",
    category: "general",
    region: "global"
  },
  {
    id: "kickasstorrents",
    name: "Kickass Torrents",
    description: "General torrent index for broader fallback coverage.",
    category: "general",
    region: "global"
  },
  {
    id: "nyaasi",
    name: "Nyaa",
    description: "Anime-focused torrent source for Japanese and fansub releases.",
    category: "anime",
    region: "global"
  },
  {
    id: "tokyotosho",
    name: "Tokyo Toshokan",
    description: "Anime and Japanese media source with niche catalog depth.",
    category: "anime",
    region: "global"
  },
  {
    id: "anidex",
    name: "Anidex",
    description: "Anime-oriented source with extra release variety.",
    category: "anime",
    region: "global"
  },
  {
    id: "rutor",
    name: "Rutor",
    description: "Russian torrent source for extra regional coverage.",
    category: "regional",
    region: "ru"
  },
  {
    id: "rutracker",
    name: "RuTracker",
    description: "Deep Russian catalog useful for difficult-to-find releases.",
    category: "regional",
    region: "ru"
  }
];

export function getProviderRegistry() {
  return PROVIDER_REGISTRY;
}
