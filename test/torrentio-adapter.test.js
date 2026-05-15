import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTorrentioStreamUrl } from "../src/providers/torrentio-adapter.js";

test("Torrentio config path includes every configured debrid account", async () => {
  const url = await buildTorrentioStreamUrl({
    enabledProviders: ["yts"],
    sortTorrentsBy: "qualitysize",
    qualityProfile: "balanced",
    maxQuality: "2160p",
    maxResults: "10",
    hideDownloadLinks: true,
    hideCatalog: true,
    debridAccounts: [
      { service: "realdebrid", apiKey: "rd-key" },
      { service: "premiumize", apiKey: "pm-key" },
      { service: "putio", apiKey: "put-token", putioClientId: "put-client" },
    ],
  }, "movie", "tt1234567");

  assert.match(url, /realdebrid=rd-key/);
  assert.match(url, /premiumize=pm-key/);
  assert.match(url, /putio=put-client%40put-token/);
});

test("Torrentio config path includes every enabled debrid connection", async () => {
  const url = await buildTorrentioStreamUrl({
    enabledProviders: ["yts"],
    sortTorrentsBy: "qualitysize",
    qualityProfile: "balanced",
    maxQuality: "2160p",
    maxResults: "10",
    hideDownloadLinks: true,
    hideCatalog: true,
    debridConnections: [
      { provider: "realdebrid", apiKey: "rd-key", enabled: true },
      { provider: "torbox", apiKey: "tb-key", enabled: true },
      { provider: "premiumize", apiKey: "pm-key", enabled: false },
    ],
  }, "movie", "tt1234567");

  assert.match(url, /realdebrid=rd-key/);
  assert.match(url, /torbox=tb-key/);
  assert.doesNotMatch(url, /premiumize=pm-key/);
});
