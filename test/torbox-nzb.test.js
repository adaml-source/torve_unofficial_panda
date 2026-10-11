import assert from "node:assert/strict";
import { test } from "node:test";
import { NzbCloudError, TorboxNzbResolver } from "../src/providers/torbox-nzb.js";

const cfg = { downloadClientApiKey: "fixture-token" };
const nzb = () => new Response('<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>');
const ok = data => Response.json({ success: true, data });
const file = { id: 8, name: "Example.S01E01.mkv", size: 1024 };
const ready = { id: 42, download_present: true, files: [file] };

test("both indexers' 403 errors stop preparation without submitting or leaking secrets", async () => {
  for (const host of ["videothek.io", "treasure-maps.com"]) {
    let calls = 0;
    const resolver = new TorboxNzbResolver({ fetchImpl: async () => { calls++; return new Response("secret upstream body", { status: 403 }); } });
    const check = () => resolver.resolve(cfg, `https://${host}/api?t=get&id=test&apikey=secret`, "Example");
    await assert.rejects(check(), error => error instanceof NzbCloudError && error.status === 403 && error.code === "nzb_access_denied" && !/secret|https:/.test(error.message));
    await assert.rejects(check(), { code: "nzb_access_denied" });
    assert.equal(calls, 1);
  }
});

test("HTML login pages and oversized NZBs are rejected before upload", async () => {
  for (const response of [new Response("<!doctype html><h1>Login required</h1>"), new Response("nzb", { headers: { "content-length": String(51 * 1024 * 1024) } })]) {
    let calls = 0;
    const resolver = new TorboxNzbResolver({ fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(resolver.resolve(cfg, "https://indexer.example/api", "Example"), error => ["nzb_invalid", "nzb_too_large"].includes(error.code));
    assert.equal(calls, 1);
  }
});

test("slow preparation responds promptly and concurrent retries share one upload", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let indexerCalls = 0, uploads = 0;
  const resolver = new TorboxNzbResolver({ requestWaitMs: 5, fetchImpl: async (url, options) => {
    if (url.startsWith("https://indexer.example")) { indexerCalls++; await gate; return nzb(); }
    if (url.includes("createusenetdownload")) {
      uploads++;
      assert.equal(options.body.get("file").type, "application/x-nzb");
      return ok({ usenetdownload_id: 42 });
    }
    if (url.includes("mylist")) return ok(ready);
    return ok("https://cdn.example/video");
  } });
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => resolver.resolve(cfg, "https://indexer.example/api", "Example"))), [null, null, null]);
  release();
  const result = await resolver.resolve(cfg, "https://indexer.example/api", "Example");
  assert.equal(result.url, "https://cdn.example/video");
  assert.equal(indexerCalls, 1);
  assert.equal(uploads, 1);
});

test("polls reuse the download ID, wait through unpacking and select the requested episode", async () => {
  let now = 0, polls = 0, uploads = 0, indexerCalls = 0, requestedFile;
  const resolver = new TorboxNzbResolver({ now: () => now, fetchImpl: async url => {
    if (url.startsWith("https://indexer.example")) { indexerCalls++; return nzb(); }
    if (url.includes("createusenetdownload")) { uploads++; return ok({ usenetdownload_id: 42 }); }
    if (url.includes("mylist")) {
      polls++;
      return ok([{ ...ready, download_present: polls > 1, download_finished: true,
        files: [file, { id: 9, name: "Example.S01E02.mkv", size: 9000 }] }]);
    }
    requestedFile = new URL(url).searchParams.get("file_id");
    return ok("https://cdn.example/correct-episode");
  } });
  assert.equal(await resolver.resolve(cfg, "https://indexer.example/api", "Example.S01E01"), null);
  assert.equal(await resolver.resolve(cfg, "https://indexer.example/api", "Example.S01E01"), null);
  assert.equal(polls, 1);
  now += 6000;
  assert.equal((await resolver.resolve(cfg, "https://indexer.example/api", "Example.S01E01")).url, "https://cdn.example/correct-episode");
  assert.equal(requestedFile, "8");
  assert.equal(uploads, 1);
  assert.equal(indexerCalls, 1);
  await resolver.resolve(cfg, "https://indexer.example/api", "Example.S01E01");
  assert.equal(polls, 2);
});

test("download failures and missing episodes remain explicit errors", async () => {
  for (const [download, code] of [[{ download_state: "failed" }, "nzb_download_failed"],
    [{ ...ready, files: [{ ...file, name: "Example.S01E02.mkv" }] }, "nzb_episode_missing"]]) {
    const resolver = new TorboxNzbResolver({ fetchImpl: async url => {
      if (url.startsWith("https://indexer.example")) return nzb();
      if (url.includes("createusenetdownload")) return ok({ usenetdownload_id: 42 });
      if (url.includes("mylist")) return ok(download);
      assert.fail("No playback link should be requested");
    } });
    await assert.rejects(resolver.resolve(cfg, "https://indexer.example/api", "Example.S01E01"), { code, status: 422 });
  }
});

test("accounts never share a download ID or cached playback link", async () => {
  let uploads = 0;
  const resolver = new TorboxNzbResolver({ fetchImpl: async (url, options) => {
    if (url.startsWith("https://indexer.example")) return nzb();
    if (url.includes("createusenetdownload")) return ok({ usenetdownload_id: ++uploads });
    if (url.includes("mylist")) return ok(ready);
    return ok(options.headers.Authorization === "Bearer account-a" ? "https://cdn.example/a" : "https://cdn.example/b");
  } });
  const a = await resolver.resolve({ downloadClientApiKey: "account-a" }, "https://indexer.example/api", "Example");
  const b = await resolver.resolve({ downloadClientApiKey: "account-b" }, "https://indexer.example/api", "Example");
  assert.notEqual(a.url, b.url);
  assert.equal(uploads, 2);
});

test("expired playback links refresh without resubmitting the NZB", async () => {
  let now = 0, uploads = 0, links = 0;
  const resolver = new TorboxNzbResolver({ now: () => now, fetchImpl: async url => {
    if (url.startsWith("https://indexer.example")) return nzb();
    if (url.includes("createusenetdownload")) { uploads++; return ok({ usenetdownload_id: 42 }); }
    if (url.includes("mylist")) return ok(ready);
    return ok(`https://cdn.example/link-${++links}`);
  } });
  const a = await resolver.resolve(cfg, "https://indexer.example/api", "Example");
  now += 31 * 60 * 1000;
  const b = await resolver.resolve(cfg, "https://indexer.example/api", "Example");
  assert.notEqual(a.url, b.url);
  assert.equal(uploads, 1);
});

test("a failed playback-link request retries that download rather than uploading again", async () => {
  let now = 0, uploads = 0, links = 0;
  const resolver = new TorboxNzbResolver({ now: () => now, fetchImpl: async url => {
    if (url.startsWith("https://indexer.example")) return nzb();
    if (url.includes("createusenetdownload")) { uploads++; return ok({ usenetdownload_id: 42 }); }
    if (url.includes("mylist")) return ok(ready);
    return ++links === 1 ? new Response("unavailable", { status: 503 }) : ok("https://cdn.example/recovered");
  } });
  await assert.rejects(resolver.resolve(cfg, "https://indexer.example/api", "Example"), { code: "download_client_unavailable" });
  now += 16000;
  assert.equal((await resolver.resolve(cfg, "https://indexer.example/api", "Example")).url, "https://cdn.example/recovered");
  assert.equal(uploads, 1);
});
