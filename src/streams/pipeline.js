import { fetchTorrentioStreams } from "../providers/torrentio-adapter.js";
import { fetchUsenetStreams } from "../providers/usenet-adapter.js";

// Hard latency cap per provider. Anything slower is dropped so the
// client (ktor default ~15s) doesn't disconnect with 499. Easynews and
// Newznab indexers regularly rate-limit us; we'd rather return partial
// results than block everything waiting on a dead upstream.
const PROVIDER_BUDGET_MS = 14000;

function withBudget(promise, source) {
  return Promise.race([
    promise.then((streams) => ({ source, streams })),
    new Promise((resolve) =>
      setTimeout(() => resolve({ source, streams: [], error: "budget_exceeded" }), PROVIDER_BUDGET_MS)
    ),
  ]).catch((err) => ({ source, streams: [], error: err.message }));
}

export async function buildStreams({
  config,
  mediaType,
  mediaId,
  proxyBaseUrl,
}) {
  const sources = [];

  sources.push(withBudget(fetchTorrentioStreams(config, mediaType, mediaId), "torrentio"));

  if (config.enableUsenet) {
    sources.push(withBudget(fetchUsenetStreams(config, mediaType, mediaId, proxyBaseUrl), "usenet"));
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
