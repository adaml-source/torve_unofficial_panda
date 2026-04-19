import { fetchTorrentioStreams } from "../providers/torrentio-adapter.js";
import { fetchUsenetStreams } from "../providers/usenet-adapter.js";

export async function buildStreams({
  config,
  mediaType,
  mediaId,
  proxyBaseUrl,
}) {
  const sources = [];

  sources.push(
    fetchTorrentioStreams(config, mediaType, mediaId)
      .then((streams) => ({ source: "torrentio", streams }))
      .catch((err) => ({ source: "torrentio", streams: [], error: err.message }))
  );

  if (config.enableUsenet) {
    sources.push(
      fetchUsenetStreams(config, mediaType, mediaId, proxyBaseUrl)
        .then((streams) => ({ source: "usenet", streams }))
        .catch((err) => ({ source: "usenet", streams: [], error: err.message }))
    );
  }

  const results = await Promise.all(sources);
  const allStreams = results.flatMap((r) => r.streams);

  return {
    streams: allStreams,
    diagnostics: {
      mediaType,
      mediaId,
      sources: results.map((r) => ({
        upstream: r.source,
        returnedStreams: r.streams.length,
        error: r.error || null,
      })),
      totalStreams: allStreams.length,
    },
  };
}
