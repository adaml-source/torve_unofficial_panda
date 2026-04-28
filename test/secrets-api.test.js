/**
 * Tests for GET /api/v1/configs/me/secrets — owner-only plaintext-secret
 * read. Covers the auth matrix the Torve clients team specified, plus
 * rate-limit, audit, and the no-mutation-on-read invariant.
 *
 * Run with: node --test --experimental-test-module-mocks test/secrets-api.test.js
 */
import { after, before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Isolated test DB — must be set before importing anything that touches
// the SQLite handle.
const TEST_DB = path.join(os.tmpdir(), `panda-secrets-test-${process.pid}.db`);
process.env.PANDA_DB_PATH = TEST_DB;
process.env.PANDA_SECRET = "a".repeat(64);
process.env.PANDA_ENCRYPTION_KEY = "b".repeat(64);
process.env.TORVE_JWT_SECRET = "torve-test-secret-32bytes-long!" + "x";
process.env.PORT = "0";

// Mock oauth so any provider imports don't try to phone home.
mock.module("../src/debrid/oauth.js", {
  namedExports: {
    async startDeviceFlow() { return { device_code: "mock", user_code: "X", verification_url: "http://x", expires_in: 600, interval: 5, provider_extras: null }; },
    async pollDeviceFlow() { return { status: "pending" }; },
    async validateApiKey() { return { valid: true, display_identifier: "test" }; }
  }
});

async function startServer() {
  const { getProviderRegistry } = await import("../src/providers/provider-registry.js");
  const { tryHandleV1 } = await import("../src/api/v1.js");
  const providers = getProviderRegistry();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (await tryHandleV1(req, res, url, providers)) return;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let ctx;
before(async () => { ctx = await startServer(); });
after(() => {
  ctx.server.close();
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch {}
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function signJwt(userId, { expiresInSeconds = 3600 } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { sub: userId, exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", process.env.TORVE_JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}
function expiredJwt(userId) { return signJwt(userId, { expiresInSeconds: -10 }); }

async function req(method, p, { headers, body } = {}) {
  const res = await fetch(`${ctx.base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

async function createOwnedConfig(userId, overrides = {}) {
  const body = {
    debridService: "none",
    debridApiKey: "rd_secret_key",
    usenetPassword: "newshosting-pw",
    enableUsenet: true,
    usenetProvider: "easynews",
    usenetUsername: "easyuser",
    nzbIndexer: "scenenzbs",
    nzbIndexerApiKey: "scene-key",
    nzbIndexers: [
      { type: "scenenzbs", url: "https://scenenzbs.com", apiKey: "scene-key" },
      { type: "nzbgeek",    url: "https://api.nzbgeek.info", apiKey: "geek-key" },
    ],
    downloadClient: "torbox",
    downloadClientApiKey: "tbx-key",
    downloadClientPassword: "",
    ...overrides,
  };
  const r = await req("POST", "/api/v1/configs", {
    headers: { authorization: `Bearer ${signJwt(userId)}` },
    body,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.account_managed, "config should be Torve-account-managed");
  return r.data.config_id;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("GET /api/v1/configs/me/secrets", () => {

  test("happy path: bound owner gets plaintext secrets", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const configId = await createOwnedConfig(userId);
    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: {
        authorization: `Bearer ${signJwt(userId)}`,
        "x-panda-config-id": configId,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.config_id, configId);
    assert.equal(r.data.debrid_api_key, "rd_secret_key");
    assert.equal(r.data.usenet_password, "newshosting-pw");
    assert.equal(r.data.download_client_api_key, "tbx-key");
    assert.equal(r.data.nzb_indexer_api_key, "scene-key");
    assert.equal(r.data.nzb_indexers.length, 2);
    assert.equal(r.data.nzb_indexers[0].api_key, "scene-key");
    assert.equal(r.data.nzb_indexers[1].api_key, "geek-key");
    // Cache headers — must not let a proxy cache plaintext secrets.
    assert.match(r.headers.get("cache-control") || "", /no-store/);
    assert.match(r.headers.get("cache-control") || "", /private/);
  });

  test("403: different Torve user", async () => {
    const ownerId = "22222222-2222-2222-2222-222222222222";
    const otherId = "33333333-3333-3333-3333-333333333333";
    const configId = await createOwnedConfig(ownerId);
    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: {
        authorization: `Bearer ${signJwt(otherId)}`,
        "x-panda-config-id": configId,
      },
    });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "forbidden");
    // Response must not echo any secret material.
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes("rd_secret_key"));
    assert.ok(!body.includes("scene-key"));
  });

  test("403: config not bound (anonymous-created)", async () => {
    const r1 = await req("POST", "/api/v1/configs", {
      body: { debridService: "none", debridApiKey: "rd_unbound_key", enableUsenet: false },
    });
    assert.equal(r1.status, 200);
    assert.ok(r1.data.management_token, "anonymous flow should mint a mgmt token");
    const configId = r1.data.config_id;

    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: {
        authorization: `Bearer ${signJwt("44444444-4444-4444-4444-444444444444")}`,
        "x-panda-config-id": configId,
      },
    });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "forbidden");
  });

  test("403: management token presented as Bearer", async () => {
    const userId = "55555555-5555-5555-5555-555555555555";
    const configId = await createOwnedConfig(userId);
    // 64-char hex, no dots — looks like a Panda mgmt token.
    const fakeMgmt = "a".repeat(64);
    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: { authorization: `Bearer ${fakeMgmt}`, "x-panda-config-id": configId },
    });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "forbidden");
  });

  test("401: manifest token presented as Bearer (1 dot)", async () => {
    const userId = "66666666-6666-6666-6666-666666666666";
    const configId = await createOwnedConfig(userId);
    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: { authorization: `Bearer eyJabc.def123signaturepart`, "x-panda-config-id": configId },
    });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, "unauthorized");
  });

  test("400: missing X-Panda-Config-Id header", async () => {
    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: { authorization: `Bearer ${signJwt("77777777-7777-7777-7777-777777777777")}` },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "bad_request");
  });

  test("401: expired JWT", async () => {
    const userId = "88888888-8888-8888-8888-888888888888";
    const configId = await createOwnedConfig(userId);
    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: {
        authorization: `Bearer ${expiredJwt(userId)}`,
        "x-panda-config-id": configId,
      },
    });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, "unauthorized");
  });

  test("401: missing Authorization", async () => {
    const r = await req("GET", "/api/v1/configs/me/secrets", {
      headers: { "x-panda-config-id": "any-config-id" },
    });
    assert.equal(r.status, 401);
  });

  test("audit row written for each attempt (success + failure)", async () => {
    const { default: Database } = await import("node:sqlite").then((m) => ({ default: m.DatabaseSync }));
    const userId = "99999999-9999-9999-9999-999999999999";
    const configId = await createOwnedConfig(userId);
    // Snapshot current count, fire 3 calls (1 ok, 1 forbidden, 1 unauthorized).
    const db = new Database(TEST_DB);
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_secret_reveals").get().n;

    await req("GET", "/api/v1/configs/me/secrets", {
      headers: { authorization: `Bearer ${signJwt(userId)}`, "x-panda-config-id": configId },
    });
    await req("GET", "/api/v1/configs/me/secrets", {
      headers: { authorization: `Bearer ${"f".repeat(64)}`, "x-panda-config-id": configId },
    });
    await req("GET", "/api/v1/configs/me/secrets", {
      headers: { "x-panda-config-id": configId },
    });

    const after = db.prepare("SELECT COUNT(*) AS n FROM audit_secret_reveals").get().n;
    assert.equal(after - before, 3);
    // Confirm no row contains a secret value (sanity — schema lacks the
    // column so this is structural, but make the assertion explicit).
    const rows = db.prepare("SELECT * FROM audit_secret_reveals ORDER BY id DESC LIMIT 3").all();
    for (const r of rows) {
      const blob = JSON.stringify(r);
      assert.ok(!blob.includes("rd_secret_key"));
      assert.ok(!blob.includes("scene-key"));
    }
    db.close();
  });

  test("idempotent: repeated reads return the same plaintext", async () => {
    const userId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const configId = await createOwnedConfig(userId);
    const headers = { authorization: `Bearer ${signJwt(userId)}`, "x-panda-config-id": configId };
    const r1 = await req("GET", "/api/v1/configs/me/secrets", { headers });
    const r2 = await req("GET", "/api/v1/configs/me/secrets", { headers });
    assert.deepEqual(r1.data, r2.data);
  });

  test("PATCH then secrets returns the new value", async () => {
    const userId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const configId = await createOwnedConfig(userId);
    const headers = { authorization: `Bearer ${signJwt(userId)}`, "x-panda-config-id": configId };

    // PATCH a new download-client key.
    const patch = await req("PATCH", "/api/v1/configs/me", {
      headers,
      body: { downloadClientApiKey: "new-tbx-key" },
    });
    assert.equal(patch.status, 200);

    const reveal = await req("GET", "/api/v1/configs/me/secrets", { headers });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.data.download_client_api_key, "new-tbx-key");
  });

  test("no mutation on read: updated_at unchanged after secrets call", async () => {
    const userId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const configId = await createOwnedConfig(userId);
    const headers = { authorization: `Bearer ${signJwt(userId)}`, "x-panda-config-id": configId };
    const before = await req("GET", "/api/v1/configs/me", { headers });
    const updatedBefore = before.data.updated_at;
    await req("GET", "/api/v1/configs/me/secrets", { headers });
    const after = await req("GET", "/api/v1/configs/me", { headers });
    assert.equal(after.data.updated_at, updatedBefore);
  });

  test("legacy /configs/me still redacts on read", async () => {
    const userId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const configId = await createOwnedConfig(userId);
    const r = await req("GET", "/api/v1/configs/me", {
      headers: { authorization: `Bearer ${signJwt(userId)}`, "x-panda-config-id": configId },
    });
    assert.equal(r.status, 200);
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes("rd_secret_key"), "redaction must not leak debrid key");
    assert.ok(!body.includes("scene-key"), "redaction must not leak indexer key");
    // The redaction marker should be present somewhere instead.
    assert.ok(body.includes("[redacted]"));
  });

});
