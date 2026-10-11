import assert from "node:assert/strict";
import { test } from "node:test";
import { newznabDownloadUrl } from "../src/providers/newznab-download.js";
import { authenticateSavedNzbUrl } from "../src/providers/usenet-adapter.js";

test("Videothek and Treasure Maps use authenticated enclosures instead of web links", () => {
  for (const host of ["videothek.io", "treasure-maps.com"]) {
    const url = new URL(newznabDownloadUrl({ link: `https://${host}/details/release`, enclosure: {
      "@attributes": { url: `https://${host}/api?t=get&amp;id=release` } } }, `https://${host}/api`, "fixture-key"));
    assert.equal(url.searchParams.get("t"), "get");
    assert.equal(url.searchParams.get("id"), "release");
    assert.equal(url.searchParams.get("apikey"), "fixture-key");
  }
});
test("GUID supplies the API download when only a website link was returned", () => {
  const url = new URL(newznabDownloadUrl({ link: "https://indexer.example/details/release", guid: "release-id" }, "https://indexer.example/api", "fixture"));
  assert.equal(url.searchParams.get("id"), "release-id");
  assert.equal(url.searchParams.get("apikey"), "fixture");
  assert.equal(newznabDownloadUrl({ link: "https://indexer.example/details/release" }, "https://indexer.example/api", "fixture"), null);
});
test("existing signed credentials and external downloads are preserved without adding the indexer key", () => {
  const item = { enclosure: { "@attributes": { url: "https://cdn.example/file.nzb?signature=signed" } } };
  assert.equal(newznabDownloadUrl(item, "https://indexer.example/api", "secret"), item.enclosure["@attributes"].url);
  assert.equal(newznabDownloadUrl({ link: "https://indexer.example/api?t=get&id=1&apikey=signed" }, "https://indexer.example/api", "other"), "https://indexer.example/api?t=get&id=1&apikey=signed");
});

test("already displayed sources recover missing API authentication only on their configured indexer", () => {
  const cfg = { nzbIndexers: [{ type: "custom", url: "https://videothek.io", apiKey: "fixture-v" },
    { type: "scenenzbs", apiKey: "fixture-t" }] };
  assert.equal(new URL(authenticateSavedNzbUrl(cfg, "https://videothek.io/api?t=get&id=1")).searchParams.get("apikey"), "fixture-v");
  const repaired = new URL(authenticateSavedNzbUrl(cfg, "https://treasure-maps.com/details/release-123"));
  assert.equal(repaired.pathname, "/api");
  assert.equal(repaired.searchParams.get("id"), "release-123");
  assert.equal(repaired.searchParams.get("apikey"), "fixture-t");
  const outside = "https://other.example/api?t=get&id=1";
  assert.equal(authenticateSavedNzbUrl(cfg, outside), outside);
});
