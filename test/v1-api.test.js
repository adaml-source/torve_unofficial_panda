/**
 * Tests for /api/v1/* API surface.
 *
 * Starts a server on a random port, makes real HTTP requests.
 * Mocks the oauth module so upstream provider APIs are not called.
 *
 * Run with: node --test test/v1-api.test.js
 */
import { after, before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use an isolated SQLite DB for tests
const TEST_DB = path.join(os.tmpdir(), `panda-test-${process.pid}.db`);
process.env.PANDA_DB_PATH = TEST_DB;
// Deterministic secrets
process.env.PANDA_SECRET = "a".repeat(64);
process.env.PANDA_ENCRYPTION_KEY = "b".repeat(64);
process.env.PORT = "0";  // random port

// Mock the oauth module BEFORE importing the server
mock.module("../src/debrid/oauth.js", {
  namedExports: {
    async startDeviceFlow(providerId) {
      return {
        device_code: `mock-${providerId}-dev-code`,
        user_code: "ABCD-1234",
        verification_url: `https://${providerId}.example/device`,
        expires_in: 600,
        interval: 5,
        provider_extras: null
      };
    },
    async pollDeviceFlow(providerId, deviceCode, extras) {
      if (deviceCode.includes("denied")) return { status: "denied" };
      if (deviceCode.includes("expired")) return { status: "expired" };
      if (deviceCode.includes("approved")) return { status: "approved", token: `${providerId}-access-token` };
      return { status: "pending" };
    },
    async validateApiKey(providerId, apiKey) {
      if (apiKey === "valid-key") return { valid: true, display_identifier: "testuser" };
      return { valid: false, error_message: "Invalid API key" };
    }
  }
});

// Helper to start the server as a child import so module-level side effects run
async function startServer() {
  const { getProviderRegistry } = await import("../src/providers/provider-registry.js");
  const { tryHandleV1 } = await import("../src/api/v1.js");
  const providers = getProviderRegistry();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (await tryHandleV1(req, res, url, providers)) return;
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

let ctx;
before(async () => { ctx = await startServer(); });
after(() => {
  ctx.server.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
});

async function req(method, p, { body, headers } = {}) {
  const res = await fetch(`${ctx.base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("GET /api/v1/providers", () => {
  test("returns provider list with auth_methods", async () => {
    const r = await req("GET", "/api/v1/providers");
    assert.equal(r.status, 200);
    const ids = r.data.providers.map((p) => p.id);
    assert.deepEqual(ids.sort(), ["alldebrid", "premiumize", "realdebrid", "torbox"]);
    const rd = r.data.providers.find((p) => p.id === "realdebrid");
    assert.ok(rd.auth_methods.includes("oauth"));
    assert.ok(rd.auth_methods.includes("apikey"));
    const tb = r.data.providers.find((p) => p.id === "torbox");
    assert.deepEqual(tb.auth_methods, ["apikey"]);
  });

  test("never exposes oauth internals", async () => {
    const r = await req("GET", "/api/v1/providers");
    const serialized = JSON.stringify(r.data);
    assert.ok(!serialized.includes("X245A4XAIBGVM"));  // RD client ID
    assert.ok(!serialized.includes("deviceCodeUrl"));
  });
});

describe("OAuth device flow", () => {
  test("start returns session for oauth-capable provider", async () => {
    const r = await req("POST", "/api/v1/debrid/realdebrid/auth/start", { body: {} });
    assert.equal(r.status, 200);
    assert.ok(r.data.device_code);
    assert.equal(r.data.user_code, "ABCD-1234");
    assert.ok(r.data.verification_url);
    assert.ok(r.data.interval);
  });

  test("start rejects apikey-only provider", async () => {
    const r = await req("POST", "/api/v1/debrid/torbox/auth/start", { body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "oauth_unsupported");
  });

  test("start rejects unknown provider", async () => {
    const r = await req("POST", "/api/v1/debrid/nope/auth/start", { body: {} });
    assert.equal(r.status, 404);
    assert.equal(r.data.code, "provider_unknown");
  });

  test("poll returns pending when session exists but provider says pending", async () => {
    const start = await req("POST", "/api/v1/debrid/realdebrid/auth/start", { body: {} });
    const r = await req("POST", "/api/v1/debrid/realdebrid/auth/poll", {
      body: { device_code: start.data.device_code }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "pending");
  });

  test("poll returns expired for unknown device_code", async () => {
    const r = await req("POST", "/api/v1/debrid/realdebrid/auth/poll", {
      body: { device_code: "unknown-code" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "expired");
  });
});

describe("API key auth", () => {
  test("valid key returns approved + encrypted credential", async () => {
    const r = await req("POST", "/api/v1/debrid/torbox/auth/apikey", {
      body: { api_key: "valid-key" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "approved");
    assert.ok(r.data.credential_ciphertext.startsWith("v1:"));
    assert.equal(r.data.display_identifier, "testuser");
    assert.equal(r.data.credential_source, "apikey");
  });

  test("invalid key rejected", async () => {
    const r = await req("POST", "/api/v1/debrid/torbox/auth/apikey", {
      body: { api_key: "bad-key" }
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "invalid_api_key");
  });

  test("missing api_key rejected", async () => {
    const r = await req("POST", "/api/v1/debrid/torbox/auth/apikey", {
      body: {}
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "missing_api_key");
  });
});

describe("Config CRUD lifecycle", () => {
  // Anonymous create flow returns a manifest token (panda_token) + a
  // management token (management_token). GET (read) accepts either; PATCH
  // / DELETE (mutating) require the management token paired with the
  // X-Panda-Config-Id header — manifest-token-as-bearer is reserved for
  // legacy rows with no management hash, which doesn't apply to freshly-
  // created anonymous configs (they always mint a management token).
  let pandaToken;
  let managementToken;
  let configId;

  test("POST /configs creates config and returns token", async () => {
    const r = await req("POST", "/api/v1/configs", {
      body: {
        enabledProviders: ["yts", "eztv"],
        qualityProfile: "best_quality",
        debridService: "realdebrid"
      }
    });
    assert.equal(r.status, 200);
    assert.ok(r.data.panda_token);
    assert.ok(r.data.manifest_url.includes("/u/") && r.data.manifest_url.endsWith("/manifest.json"));
    assert.ok(r.data.management_token, "anonymous create must mint a management token");
    pandaToken = r.data.panda_token;
    managementToken = r.data.management_token;
    configId = r.data.config_id;
  });

  test("GET /configs/me requires bearer", async () => {
    const r = await req("GET", "/api/v1/configs/me");
    assert.equal(r.status, 401);
    assert.equal(r.data.code, "unauthorized");
  });

  test("GET /configs/me returns redacted config", async () => {
    const r = await req("GET", "/api/v1/configs/me", {
      headers: { authorization: `Bearer ${pandaToken}` }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.config.qualityProfile, "best_quality");
  });

  test("PATCH /configs/me updates fields", async () => {
    const r = await req("PATCH", "/api/v1/configs/me", {
      headers: {
        authorization: `Bearer ${managementToken}`,
        "x-panda-config-id": configId,
      },
      body: { maxQuality: "720p" }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.config.maxQuality, "720p");
    // Unspecified fields retained
    assert.equal(r.data.config.qualityProfile, "best_quality");
  });

  test("DELETE /configs/me removes config", async () => {
    const r = await req("DELETE", "/api/v1/configs/me", {
      headers: {
        authorization: `Bearer ${managementToken}`,
        "x-panda-config-id": configId,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.deleted, true);

    // Subsequent GET fails
    const r2 = await req("GET", "/api/v1/configs/me", {
      headers: { authorization: `Bearer ${pandaToken}` }
    });
    assert.equal(r2.status, 401);
  });
});

describe("CORS", () => {
  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await fetch(`${ctx.base}/api/v1/providers`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});
