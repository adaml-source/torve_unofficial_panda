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
  rotateManifestTokenVersion,
  saveConfig,
  setManagementTokenHash,
  stripRedactionMarkers,
  updateConfig
} from "../config/config-store.js";
import { encryptSecret } from "../lib/crypto.js";
import crypto from "node:crypto";

/**
 * Generate a raw management token (opaque 32-byte random, hex encoded) and
 * its sha256 hash. The raw value is shown to the caller once; only the hash
 * is persisted, so a DB snapshot doesn't expose working tokens.
 */
function newManagementToken() {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function hashManagementToken(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function timingSafeHashEqual(a, b) {
  const ab = Buffer.from(a || "", "hex");
  const bb = Buffer.from(b || "", "hex");
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}
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
  const decoded = await decodeConfigToken(token);
  if (!decoded) return null;
  const record = await getConfigRecord(decoded.configId);
  if (!record) return null;
  // Enforce manifest token rotation — stale token => same result as bad sig.
  if (decoded.tokenVersion !== (record.manifestTokenVersion || 1)) return null;
  return { token, configId: decoded.configId, record };
}

/**
 * Authorise a mutating operation (PATCH / DELETE / rotate). Accepts:
 *   - Bearer <management_token>           preferred; compares against the
 *                                         sha256 hash stored on the config row
 *   - Bearer <manifest_token>             fallback ONLY for legacy rows that
 *                                         don't yet have a management token.
 *                                         Callers should immediately rotate
 *                                         to provision one.
 * Returns { record, usedLegacyAuth: boolean } on success, null on failure.
 */
async function resolveManagementAuth(request) {
  const auth = request.headers["authorization"] || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const rawToken = match[1].trim();

  // Try management-token first (opaque hex, no "."), then manifest-token.
  if (!rawToken.includes(".")) {
    const incomingHash = hashManagementToken(rawToken);
    // We don't know which config this belongs to without a scan, so require
    // the caller to also identify the config via the X-Panda-Config-Id header
    // OR to present a manifest bearer alongside it.
    // Simpler: require management tokens to be paired with a manifest bearer
    // in the X-Panda-Config header. For the v1 flow, the caller already knows
    // their config_id from the creation response — trust it from a header.
    const configId = request.headers["x-panda-config-id"];
    if (!configId || typeof configId !== "string") return null;
    const record = await getConfigRecord(configId);
    if (!record || !record.managementTokenHash) return null;
    if (!timingSafeHashEqual(incomingHash, record.managementTokenHash)) return null;
    return { record, configId, usedLegacyAuth: false };
  }

  // Manifest-token fallback path (legacy configs with no management hash yet)
  const manifestResolved = await resolveBearer(request);
  if (!manifestResolved) return null;
  if (manifestResolved.record.managementTokenHash) {
    // Row already has a management token — manifest bearer no longer auths writes.
    return null;
  }
  return { record: manifestResolved.record, configId: manifestResolved.configId, usedLegacyAuth: true };
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

  // POST /api/v1/configs/me/rotate-manifest — revokes the current manifest URL
  // and issues a new one. Use this when a stream URL has leaked.
  if (request.method === "POST" && url.pathname === "/api/v1/configs/me/rotate-manifest") {
    const mgmt = await resolveManagementAuth(request);
    if (!mgmt) return sendV1Error(response, 401, "unauthorized", "Management token required");
    const nextVersion = await rotateManifestTokenVersion(mgmt.configId);
    if (!nextVersion) return sendV1Error(response, 404, "not_found", "Config not found");
    const token = await encodeConfigToken(mgmt.configId, nextVersion);
    const baseUrl = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
    return sendV1Json(response, 200, {
      config_id: mgmt.configId,
      panda_token: token,
      manifest_url: `${baseUrl}/u/${token}/manifest.json`,
      manifest_token_version: nextVersion,
    });
  }

  // POST /api/v1/configs/me/rotate-management — replaces the management token
  // with a newly-minted one, returned ONCE in the response. Use this when the
  // management token leaks, or to provision one for a legacy config that
  // never had one.
  if (request.method === "POST" && url.pathname === "/api/v1/configs/me/rotate-management") {
    const mgmt = await resolveManagementAuth(request);
    if (!mgmt) return sendV1Error(response, 401, "unauthorized", "Management token required");
    const next = newManagementToken();
    const ok = await setManagementTokenHash(mgmt.configId, next.hash);
    if (!ok) return sendV1Error(response, 404, "not_found", "Config not found");
    return sendV1Json(response, 200, {
      config_id: mgmt.configId,
      management_token: next.raw,
      management_token_notice: "Save this immediately — it's shown only once. Required for future edits / rotations.",
    });
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

  // Create flow has no prior config to merge against; any "[redacted]"
  // placeholders get blanked so sanitizeConfig applies defaults.
  const config = sanitizeConfig(stripRedactionMarkers(body), providers);
  // Issue a management token at creation time. The RAW value is returned once
  // here and never again; only its sha256 hash is persisted. Callers must
  // store the raw value securely — losing it means losing edit access to the
  // config (though the stream URL keeps working, since that's a separate
  // token). This is the key property that makes a leaked manifest URL
  // survivable: stream-only, not editable.
  const mgmt = newManagementToken();
  const record = await saveConfig(config, { managementTokenHash: mgmt.hash });
  const token = await encodeConfigToken(record.id, record.manifestTokenVersion || 1);
  const baseUrl = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
  return sendV1Json(response, 200, {
    config_id: record.id,
    panda_token: token,
    manifest_url: `${baseUrl}/u/${token}/manifest.json`,
    management_token: mgmt.raw,
    management_token_notice: "Save this management token now — it's shown only once and is required to edit or delete this config later. Present it as `Authorization: Bearer <token>` with `X-Panda-Config-Id: <config_id>`.",
    expires_at: null
  });
}

async function handleConfigMe(request, response, providers) {
  // GET is read-only: the manifest token alone suffices. PATCH / DELETE are
  // mutating and require the management token (sha256-hash-matched) so that a
  // leaked stream URL can't be used to tamper with credentials.
  if (request.method === "GET") {
    // Read-only, so accept EITHER token. Manifest-token path is used by
    // the normal "open my config for editing" flow; management-token path
    // is used by the client's recovery flow to validate a pasted admin-
    // issued token before storing it. Either way the response is secret-
    // redacted, so this widens accessibility without leaking anything.
    const mgmt = await resolveManagementAuth(request);
    if (mgmt) {
      return sendV1Json(response, 200, {
        config_id: mgmt.configId,
        config: redactConfigSecrets(mgmt.record.config),
        updated_at: mgmt.record.updatedAt,
        has_management_token: !!mgmt.record.managementTokenHash,
      });
    }
    const auth = await resolveBearer(request);
    if (!auth) return sendV1Error(response, 401, "unauthorized", "Valid panda_token or management_token required");
    return sendV1Json(response, 200, {
      config_id: auth.configId,
      config: redactConfigSecrets(auth.record.config),
      updated_at: auth.record.updatedAt,
      has_management_token: !!auth.record.managementTokenHash,
    });
  }

  const mgmt = await resolveManagementAuth(request);
  if (!mgmt) {
    return sendV1Error(
      response, 401, "unauthorized",
      "This operation requires the management token. Send `Authorization: Bearer <management_token>` plus `X-Panda-Config-Id: <config_id>`.",
    );
  }
  const { configId, record, usedLegacyAuth } = mgmt;

  if (request.method === "PATCH") {
    const body = await readJsonBody(request);
    if (body == null) return sendV1Error(response, 400, "invalid_json", "Body must be JSON");
    // Clients that re-send the last GET response will include "[redacted]"
    // for every secret (see redactConfigSecrets). Restore the real stored
    // value for any field the client didn't deliberately replace.
    const unredactedBody = stripRedactionMarkers(body, record.config);
    // Merge: unspecified fields keep existing value.
    const merged = { ...record.config, ...unredactedBody };
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
      updated_at: updated.updatedAt,
      used_legacy_auth: usedLegacyAuth || undefined,
    });
  }

  if (request.method === "DELETE") {
    await deleteConfig(configId);
    return sendV1Json(response, 200, { deleted: true });
  }

  return sendV1Error(response, 405, "method_not_allowed", `Method ${request.method} not supported`);
}
