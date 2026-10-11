import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchUsenetStreams } from "../src/providers/usenet-adapter.js";

const episode = "tt0386676:1:5";
const item = (name) => ({ title: `${name}.S01E05.GERMAN.1080p`, link: `https://indexer.example/get/${name}.nzb` });
const config = (indexers) => ({ enableUsenet: true, usenetProvider: "none", downloadClient: "none", nzbIndexers: indexers });

test("Treasure Maps searches The Office US S01E05 on its current API", async (t) => {
  let requested;
  t.mock.method(globalThis, "fetch", async (value) => {
    requested = new URL(value);
    return Response.json({ channel: { item: [item("Office")] } });
  });
  const rows = await fetchUsenetStreams(config([{ type: "scenenzbs", apiKey: "fixture-treasure" }]), "series", episode);
  assert.equal(requested.origin, "https://treasure-maps.com");
  assert.equal(requested.pathname, "/api");
  assert.equal(requested.searchParams.get("t"), "tvsearch");
  assert.equal(requested.searchParams.get("imdbid"), "0386676");
  assert.equal(requested.searchParams.get("season"), "1");
  assert.equal(requested.searchParams.get("ep"), "5");
  assert.equal(rows.length, 1);
});

test("custom API URL is not changed to /api/api and single-item JSON is retained", async (t) => {
  let requested;
  t.mock.method(globalThis, "fetch", async (value) => {
    requested = new URL(value);
    return Response.json({ channel: { item: item("One") } });
  });
  const rows = await fetchUsenetStreams(config([{ type: "custom", url: "https://custom.example/newznab/api/", apiKey: "fixture-custom" }]), "series", episode);
  assert.equal(requested.pathname, "/newznab/api");
  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /custom\.example/);
});

test("two custom indexers with the same API-key prefix have independent caches", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (value) => {
    calls++;
    return Response.json({ channel: { item: [item(new URL(value).hostname)] } });
  });
  const first = await fetchUsenetStreams(config([{ type: "custom", url: "https://first.example", apiKey: "same-key-one" }]), "series", episode);
  const second = await fetchUsenetStreams(config([{ type: "custom", url: "https://second.example", apiKey: "same-key-two" }]), "series", episode);
  assert.equal(calls, 2);
  assert.notEqual(first[0].title, second[0].title);
});

test("a failed indexer does not hide results from another configured indexer", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (value) => new URL(value).hostname === "failed.example"
    ? new Response("upstream unavailable", { status: 503 })
    : Response.json({ channel: { item: [item("Working")] } }));
  const rows = await fetchUsenetStreams(config([
    { type: "custom", url: "https://failed.example/api", apiKey: "failed-fixture" },
    { type: "custom", url: "https://working.example/api", apiKey: "working-fixture" },
  ]), "series", episode);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /^Working/);
});

test("discovery does not submit an NZB to a download client", async (t) => {
  process.env.PANDA_SECRET = "local-fixture-signing-key";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (value) => {
    calls.push(new URL(value).hostname);
    return Response.json({ channel: { item: [item("Cloud")] } });
  });
  const cfg = { ...config([{ type: "custom", url: "https://cloud-indexer.example", apiKey: "cloud-fixture" }]), downloadClient: "torbox", downloadClientApiKey: "fixture-not-real" };
  const rows = await fetchUsenetStreams(cfg, "series", episode, "https://panda.example/u/test", "fixture-config");
  assert.deepEqual(calls, ["cloud-indexer.example"]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].url, /^https:\/\/panda\.example\/u\/test\/nzb\//);
});

test("Videothek RSS keeps the episode, NZB URL, size, and separate track hints", async (t) => {
  let requested;
  t.mock.method(globalThis, "fetch", async (value) => {
    requested = new URL(value);
    return new Response(`<?xml version="1.0"?><rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><item>
      <title><![CDATA[The.Office.US.S01E05.1080p]]></title>
      <link>https://videothek.io/api?t=get&amp;id=fixture&amp;apikey=test-only</link>
      <enclosure url="https://videothek.io/api?t=get&amp;id=fixture" length="1073741824" type="application/x-nzb"/>
      <newznab:attr name="language" value="English"/><newznab:attr name="subs" value="German, French"/>
    </item></channel></rss>`, { headers: { "Content-Type": "application/rss+xml" } });
  });
  const rows = await fetchUsenetStreams(config([{ type: "custom", url: "https://videothek.io/api", apiKey: "videothek-fixture" }]), "series", episode);
  assert.equal(requested.pathname, "/api");
  assert.equal(requested.searchParams.get("extended"), "1");
  assert.equal(rows.length, 1);
  assert.match(rows[0].url, /t=get&id=fixture&apikey=test-only/);
  assert.match(rows[0].title, /1\.0 GB/);
  assert.match(rows[0].title, /🗣️ English/);
  assert.match(rows[0].title, /💬 German, French/);
  assert.doesNotMatch(rows[0].title, /🗣️ German/);
});

test("JSON extended attributes preserve subtitle-only languages", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ channel: { item: [{ ...item("Subtitle"),
    "newznab:attr": [{ "@attributes": { name: "language", value: "English" } }, { "@attributes": { name: "subs", value: "German" } }],
  }] } }));
  const rows = await fetchUsenetStreams(config([{ type: "custom", url: "https://attributes.example", apiKey: "attributes-fixture" }]), "series", episode);
  assert.match(rows[0].title, /🗣️ English/);
  assert.match(rows[0].title, /💬 German/);
});

test("XML auth errors, HTML login pages and DTDs are not cached as valid empty searches", async (t) => {
  t.mock.method(console, "error", () => {});
  const replies = [
    '<error code="100" description="Incorrect user credentials"/>',
    '<html><body>Login required</body></html>',
    '<!DOCTYPE rss [<!ENTITY x "value">]><rss><channel/></rss>',
    '<rss><channel><item><title>Recovered.S01E05</title><link>https://indexer.example/fixture.nzb</link></item></channel></rss>',
  ];
  t.mock.method(globalThis, "fetch", async () => new Response(replies.shift()));
  const cfg = config([{ type: "custom", url: "https://recovery.example", apiKey: "recovery-fixture" }]);
  for (let i = 0; i < 3; i++) assert.deepEqual(await fetchUsenetStreams(cfg, "series", episode), []);
  assert.equal((await fetchUsenetStreams(cfg, "series", episode)).length, 1);
});

test("a stalled Easynews lookup cannot erase completed indexer results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (value) => new URL(value).hostname === "quick-indexer.example"
    ? Response.json({ channel: { item: [item("Quick")] } }) : new Promise(() => {}));
  const cfg = { ...config([{ type: "custom", url: "https://quick-indexer.example", apiKey: "quick-fixture" }]),
    usenetProvider: "easynews", usenetUsername: "fixture", usenetPassword: "fixture" };
  const pending = fetchUsenetStreams(cfg, "series", episode);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(13000);
  const rows = await pending;
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /^Quick/);
});
