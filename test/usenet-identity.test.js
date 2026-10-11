import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesUsenetIdentity } from "../src/providers/usenet-identity.js";
import { parseNewznabResponse } from "../src/providers/newznab-response.js";
import { fetchUsenetStreams } from "../src/providers/usenet-adapter.js";

const requested = { imdbId: "tt0386676", mediaType: "series", year: "2005–2013", season: 1, episode: 6 };
test("The Office US retains 2005/yearless releases and rejects 2024, UK and wrong episodes", () => {
  for (const title of ["The.Office.US.2005.S01E06.German.1080p", "The.Office.US.S01E06.1080p", "The.Office.S01E06.2024.Remaster.1080p"]) {
    assert.equal(matchesUsenetIdentity({ title }, requested), true, title);
  }
  for (const title of ["The.Office.2024.S01E06.1080p", "The.Office.2001.S01E06.1080p", "The.Office.US.S01E05.1080p", "The.Office.US.S02E06.1080p"]) {
    assert.equal(matchesUsenetIdentity({ title }, requested), false, title);
  }
  assert.equal(matchesUsenetIdentity({ title: "The.Office.S01E06", imdbId: "tt0290978" }, requested), false);
  assert.equal(matchesUsenetIdentity({ title: "The.Office.S01E06", imdbId: "0386676" }, requested), true);
  assert.equal(matchesUsenetIdentity({ title: "The.Office.S01E06", season: "S02", episode: "E06" }, requested), false);
});

test("XML and JSON retain identity attributes independently of audio/subtitle metadata", () => {
  const xml = `<rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><item><title>The.Office.S01E06</title>
    <newznab:attr name="imdb" value="0290978"/><newznab:attr name="season" value="1"/><newznab:attr name="episode" value="6"/>
    </item></channel></rss>`;
  assert.equal(matchesUsenetIdentity(parseNewznabResponse(xml)[0], requested), false);
  const json = JSON.stringify({ channel: { item: { title: "The.Office.S01E06", "newznab:attr": [{ name: "imdbid", value: "tt0386676" }] } } });
  assert.equal(matchesUsenetIdentity(parseNewznabResponse(json)[0], requested), true);
});

test("discovery removes remakes before the display limit and retains correct Office S1E6", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async value => {
    const url = new URL(value); calls.push(url);
    if (url.hostname === "v3-cinemeta.strem.io") return Response.json({ meta: { name: "The Office", releaseInfo: "2005–2013" } });
    const release = title => ({ title, link: `https://identity-fixture.example/get/${encodeURIComponent(title)}.nzb` });
    return Response.json({ channel: { item: [
      ...Array.from({ length: 17 }, (_, i) => release(`The.Office.2024.S01E06.1080p.Group${i}`)),
      release("The.Office.US.2005.S01E06.1080p"), release("The.Office.US.S01E06.GERMAN.1080p"),
      { ...release("The.Office.S01E06.1080p"), imdbid: "tt0290978" },
    ] } });
  });
  const rows = await fetchUsenetStreams({ enableUsenet: true, usenetProvider: "none", downloadClient: "none",
    nzbIndexers: [{ type: "custom", url: "https://identity-fixture.example", apiKey: "fixture" }] }, "series", "tt0386676:1:6");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.title.startsWith("The.Office.US.")));
  assert.equal(calls.find(url => url.hostname === "identity-fixture.example").searchParams.get("imdbid"), "0386676");
});
