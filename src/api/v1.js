/**
 * Panda Mobile API — stable v1.
 *
 * All routes under /api/v1/*. Structured error shape: { code, message }.
 * CORS enabled for app use. Bearer token auth for /configs/me.
 *
 * Routes:
 *   GET    /api/v1/providers
 *   POST   /api/v1/debrid/:provider/auth/start
 *   POST   /api/v1/debrid/:provider/auth/poll
 *   POST   /api/v1/debrid/:provider/auth/apikey
 *   POST   /api/v1/configs
 *   GET    /api/v1/configs/me
 *   PATCH  /api/v1/configs/me
 *   DELETE /api/v1/configs/me
 */
import {
  decodeConfigToken,
  encodeConfigToken
} from "../config/config-token.js";
import {
  createDefaultConfig,
  DEBRID_SERVICES,
  DOWNLOAD_CLIENTS,
  NZB_INDEXERS,
  QUALITY_OPTIONS,
  QUALITY_PROFILES,
  RELEASE_LANGUAGES,
  RESULT_LIMITS,
  sanitizeConfig,
  SORT_OPTIONS,
  USENET_PROVIDERS
} from "../config/schema.js";
import {
  deleteConfig,
  getConfigRecord,
  redactConfigSecrets,
  saveConfig,
  updateConfig
} from "../config/config-store.js";
import { encryptSecret } from "../lib/crypto.js";
import { getProvider, publicProviderList } from "../debrid/providers.js";
import {
  pollDeviceFlow,
  startDeviceFlow,
  validateApiKey
} from "../debrid/oauth.js";
import {
  createSession,
  deleteSession,
  getSession
} from "../debrid/session-store.js";

// ── HTTP helpers ────────────────────────────────────────────────────────

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-max-age", "86400");
}

export function sendV1Json(response, statusCode, body) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendV1Error(response, statusCode, code, message) {
  sendV1Json(response, statusCode, { code, message });
}

function handleOptions(response) {
  setCorsHeaders(response);
  response.writeHead(204);
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function resolveBearer(request) {
  const auth = request.headers["authorization"] || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  const configId = await decodeConfigToken(token);
  if (!configId) return null;
  const record = await getConfigRecord(configId);
  if (!record) return null;
  return { token, configId, record };
}

// ── Routes ──────────────────────────────────────────────────────────────

/**
 * Returns true if the request was handled by the v1 API.
 * The main server loop should short-circuit on this.
 */
export async function tryHandleV1(request, response, url, providers) {
  if (!url.pathname.startsWith("/api/v1/")) return false;

  if (request.method === "OPTIONS") {
    handleOptions(response);
    return true;
  }

  // GET /api/v1/providers
  if (request.method === "GET" && url.pathname === "/api/v1/providers") {
    sendV1Json(response, 200, { providers: publicProviderList() });
    return true;
  }

  // GET /api/v1/schema — enum options + field requirements for each
  // download client. Clients (Torve Android/iOS/TV) should read this to
  // populate dropdowns instead of hardcoding the lists, so Panda can add new
  // options (e.g. a new NZB cloud service) without an app release.
  if (request.method === "GET" && url.pathname === "/api/v1/schema") {
    sendV1Json(response, 200, {
      debridServices: DEBRID_SERVICES,
      usenetProviders: USENET_PROVIDERS,
      nzbIndexers: NZB_INDEXERS,
      downloadClients: DOWNLOAD_CLIENTS,
      qualityOptions: QUALITY_OPTIONS,
      qualityProfiles: QUALITY_PROFILES,
      releaseLanguages: RELEASE_LANGUAGES,
      sortOptions: SORT_OPTIONS,
      resultLimits: RESULT_LIMITS,
      // Per-download-client field requirements: which of
      // {url, username, password, apiKey} the client should collect.
      downloadClientFields: {
        none:       { fields: [] },
        nzbget:     { fields: ["url", "username", "password"] },
        sabnzbd:    { fields: ["url", "apiKey"] },
        premiumize: { fields: ["apiKey"], cloud: true },
        torbox:     { fields: ["apiKey"], cloud: true },
        alldebrid:  { fields: ["apiKey"], cloud: true },
      },
    });
    return true;
  }

  // /api/v1/debrid/:provider/auth/...
  const authMatch = url.pathname.match(/^\/api\/v1\/debrid\/([^/]+)\/auth\/(start|poll|apikey)$/);
  if (authMatch) {
    const [, providerId, action] = authMatch;
    if (request.method !== "POST") {
      sendV1Error(response, 405, "method_not_allowed", "Use POST");
      return true;
    }
    await handleAuthAction(request, response, providerId, action);
    return true;
  }

  // POST /api/v1/configs
  if (request.method === "POST" && url.pathname === "/api/v1/configs") {
    await handleCreateConfig(request, response, providers);
    return true;
  }

  // /api/v1/configs/me
  if (url.pathname === "/api/v1/configs/me") {
    await handleConfigMe(request, response, providers);
    return true;
  }

  sendV1Error(response, 404, "not_found", "Unknown /api/v1 endpoint");
  return true;
}

// ── Auth action handler ────────────────────────────────────────────────

async function handleAuthAction(request, response, providerId, action) {
  const provider = getProvider(providerId);
  if (!provider) {
    return sendV1Error(response, 404, "provider_unknown", `Unknown provider: ${providerId}`);
  }

  if (action === "start") {
    if (!provider.authMethods.includes("oauth")) {
      return sendV1Error(response, 400, "oauth_unsupported", `${provider.name} does not support OAuth. Use apikey instead.`);
    }
    try {
      const result = await startDeviceFlow(providerId);
      const session = createSession(providerId, result);
      return sendV1Json(response, 200, session);
    } catch (err) {
      return sendV1Error(response, 502, "oauth_start_failed", err.message || "Could not start OAuth flow");
    }
  }

  if (action === "poll") {
    const body = await readJsonBody(request);
    if (body == null) return sendV1Error(response, 400, "invalid_json", "Body must be JSON");
    const deviceCode = body?.device_code;
    if (!deviceCode) return sendV1Error(response, 400, "missing_device_code", "device_code is required");

    const session = getSession(deviceCode);
    if (!session) {
      return sendV1Json(response, 200, { status: "expired" });
    }
    if (session.provider_id !== providerId) {
      return sendV1Error(response, 400, "provider_mismatch", "device_code does not belong to this provider");
    }
    if (session.expires_at < Date.now()) {
      deleteSession(deviceCode);
      return sendV1Json(response, 200, { status: "expired" });
    }

    try {
      const pollResult = await pollDeviceFlow(
        providerId, session.provider_device_code, session.provider_extras
      );
      if (pollResult.status === "approved" && pollResult.token) {
        // Validate and encrypt; return encrypted blob + display identifier
        const validation = await validateApiKey(providerId, pollResult.token);
        const ciphertext = await encryptSecret(pollResult.token);
        deleteSession(deviceCode);
        return sendV1Json(response, 200, {
          status: "approved",
          credential_ciphertext: ciphertext,
          display_identifier: validation.valid ? validation.display_identifier : null,
          credential_source: "oauth"
        });
      }
      if (pollResult.status === "denied" || pollResult.status === "expired") {
        deleteSession(deviceCode);
      }
      return sendV1Json(response, 200, { status: pollResult.status });
    } catch (err) {
      return sendV1Error(response, 502, "oauth_poll_failed", err.message || "Poll failed");
    }
  }

  if (action === "apikey") {
    if (!provider.authMethods.includes("apikey")) {
      return sendV1Error(response, 400, "apikey_unsupported", `${provider.name} does not accept API keys`);
    }
    const body = await readJsonBody(request);
    if (body == null) return sendV1Error(response, 400, "invalid_json", "Body must be JSON");
    const apiKey = typeof body?.api_key === "string" ? body.api_key.trim() : "";
    if (!apiKey) return sendV1Error(response, 400, "missing_api_key", "api_key is required");

    const result = await validateApiKey(providerId, apiKey);
    if (!result.valid) {
      return sendV1Error(response, 400, "invalid_api_key", result.error_message || "Invalid API key");
    }
    const ciphertext = await encryptSecret(apiKey);
    return sendV1Json(response, 200, {
      status: "approved",
      credential_ciphertext: ciphertext,
      display_identifier: result.display_identifier || null,
      credential_source: "apikey"
    });
  }
}

// ── Config handlers ────────────────────────────────────────────────────

async function handleCreateConfig(request, response, providers) {
  const body = await readJsonBody(request);
  if (body == null) return sendV1Error(response, 400, "invalid_json", "Body must be JSON");

  const config = sanitizeConfig(body, providers);
  const record = await saveConfig(config);
  const token = await encodeConfigToken(record.id);
  const baseUrl = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
  return sendV1Json(response, 200, {
    panda_token: token,
    manifest_url: `${baseUrl}/u/${token}/manifest.json`,
    expires_at: null
  });
}

async function handleConfigMe(request, response, providers) {
  const auth = await resolveBearer(request);
  if (!auth) {
    return sendV1Error(response, 401, "unauthorized", "Valid panda_token required");
  }
  const { configId, record } = auth;

  if (request.method === "GET") {
    return sendV1Json(response, 200, {
      config_id: configId,
      config: redactConfigSecrets(record.config),
      updated_at: record.updatedAt
    });
  }

  if (request.method === "PATCH") {
    const body = await readJsonBody(request);
    if (body == null) return sendV1Error(response, 400, "invalid_json", "Body must be JSON");
    // Merge: unspecified fields keep existing value. Secrets kept unless replaced.
    const merged = { ...record.config, ...body };
    const nextConfig = sanitizeConfig(merged, providers);
    // Preserve secrets if caller didn't replace them (sanitizeConfig strips unknown ciphertext back to "")
    if (!body.debridCredentialCiphertext && record.config.debridCredentialCiphertext) {
      nextConfig.debridCredentialCiphertext = record.config.debridCredentialCiphertext;
      nextConfig.debridCredentialSource = record.config.debridCredentialSource;
      nextConfig.debridDisplayIdentifier = record.config.debridDisplayIdentifier;
    }
    if (!body.debridApiKey && record.config.debridApiKey) {
      nextConfig.debridApiKey = record.config.debridApiKey;
    }
    const updated = await updateConfig(configId, nextConfig);
    return sendV1Json(response, 200, {
      config_id: configId,
      config: redactConfigSecrets(updated.config),
      updated_at: updated.updatedAt
    });
  }

  if (request.method === "DELETE") {
    await deleteConfig(configId);
    return sendV1Json(response, 200, { deleted: true });
  }

  return sendV1Error(response, 405, "method_not_allowed", `Method ${request.method} not supported`);
}
