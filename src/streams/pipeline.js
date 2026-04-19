import { fetchTorrentioStreams } from "../providers/torrentio-adapter.js";

export async function buildStreams({
  config,
  mediaType,
  mediaId
}) {
  const streams = await fetchTorrentioStreams(config, mediaType, mediaId);

  return {
    streams,
    diagnostics: {
      mediaType,
      mediaId,
      upstream: "torrentio",
      returnedStreams: streams.length
    }
  };
}
