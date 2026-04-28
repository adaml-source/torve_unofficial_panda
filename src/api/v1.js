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
  auditSecretReveal,
  countSecretRevealSuccesses,
  deleteConfig,
  getConfigRecord,
  redactConfigSecrets,
  rotateManifestTokenVersion,
  saveConfig,
  setManagementTokenHash,
  setOwnerTorveUserId,
  stripRedactionMarkers,
  updateConfig
} from "../config/config-store.js";
import { encryptSecret } from "../lib/crypto.js";
import { auditLog } from "../lib/audit.js";
import { verifyTorveJwt, verifyTorveJwtFromRequest } from "../lib/torve-jwt.js";
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
 * Authorise a mutating operation (PATCH / DELETE / rotate). Accepts, in
 * priority order:
 *   1. A valid Torve JWT (Authorization: Bearer <jwt>, or ?torve_token=<jwt>)
 *      whose sub is the recorded owner_torve_user_id of the config — or
 *      whose sub will be recorded as the owner if the row is currently
 *      unowned (lazy-claim path). This is the primary auth mechanism for
 *      Torve users from 2026-04-26 onwards; eliminates the management_token
 *      requirement entirely for them.
 *   2. Bearer <management_token>           opaque hex, sha256-matched against
 *                                          the row's stored hash.
 *   3. Bearer <manifest_token>             legacy fallback ONLY for rows
 *                                          with neither owner_torve_user_id
 *                                          nor management_token_hash. These
 *                                          should immediately rotate to
 *                                          provision proper auth.
 * Returns { record, configId, usedLegacyAuth, authMethod } on success,
 * null on failure. authMethod is one of "torve_account" | "management" |
 * "legacy_manifest".
 */
async function resolveManagementAuth(request, parsedUrl = null) {
  // 1. Torve account auth — works for configs the JWT's user already owns.
  //    Lazy-claim is intentionally narrow: only fires when the row has
  //    NEITHER an owner NOR a management_token_hash, i.e. genuinely no
  //    other auth is configured. Rows that still have a management_token
  //    must be explicitly migrated (via the backfill script that walks
  //    torve-backend's user_integrations table) — otherwise any Torve user
  //    who guessed/discovered a config_id could claim someone else's row.
  const torveAuth = verifyTorveJwtFromRequest(request, parsedUrl);
  if (torveAuth) {
    const configId = request.headers["x-panda-config-id"];
    if (configId && typeof configId === "string") {
      const record = await getConfigRecord(configId);
      if (record) {
        if (record.ownerTorveUserId === torveAuth.userId) {
          return { record, configId, usedLegacyAuth: false, authMethod: "torve_account" };
        }
        if (!record.ownerTorveUserId && !record.managementTokenHash) {
          await setOwnerTorveUserId(configId, torveAuth.userId);
          const refreshed = await getConfigRecord(configId);
          return { record: refreshed, configId, usedLegacyAuth: false, authMethod: "torve_account_claim" };
        }
        // Row owned by a different user OR has a management token still
        // outstanding — fall through to the other auth methods.
      }
    }
    // No config id supplied — fall through; the caller may still be
    // presenting a management or manifest token.
  }

  const auth = request.headers["authorization"] || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const rawToken = match[1].trim();

  // 2. Management token (opaque hex, no "." — distinguishes it from JWT).
  if (!rawToken.includes(".")) {
    const incomingHash = hashManagementToken(rawToken);
    const configId = request.headers["x-panda-config-id"];
    if (!configId || typeof configId !== "string") return null;
    const record = await getConfigRecord(configId);
    if (!record || !record.managementTokenHash) return null;
    if (!timingSafeHashEqual(incomingHash, record.managementTokenHash)) return null;
    return { record, configId, usedLegacyAuth: false, authMethod: "management" };
  }

  // 3. Manifest-token legacy fallback — only for rows with no other auth.
  const manifestResolved = await resolveBearer(request);
  if (!manifestResolved) return null;
  if (manifestResolved.record.managementTokenHash) return null;
  if (manifestResolved.record.ownerTorveUserId) return null;
  return {
    record: manifestResolved.record,
    configId: manifestResolved.configId,
    usedLegacyAuth: true,
    authMethod: "legacy_manifest",
  };
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
    await handleCreateConfig(request, response, providers, url);
    return true;
  }

  // /api/v1/configs/me
  if (url.pathname === "/api/v1/configs/me") {
    await handleConfigMe(request, response, providers, url);
    return true;
  }

  // GET /api/v1/configs/me/secrets — owner-only plaintext-secret read.
  // The other /configs/me endpoints redact every secret on read; this one
  // returns them unredacted so a Torve client signed in as the config
  // owner can hydrate its local IntegrationSecretStore on every device,
  // not just the one that did the original save. Auth is intentionally
  // narrow: only a Torve JWT for the config's owner_torve_user_id is
  // accepted — management tokens are rejected with 403, manifest tokens
  // and any other invalid bearer get 401.
  if (request.method === "GET" && url.pathname === "/api/v1/configs/me/secrets") {
    await handleRevealSecrets(request, response);
    return true;
  }

  // POST /api/v1/configs/me/rotate-manifest — revokes the current manifest URL
  // and issues a new one. Use this when a stream URL has leaked.
  if (request.method === "POST" && url.pathname === "/api/v1/configs/me/rotate-manifest") {
    const mgmt = await resolveManagementAuth(request, url);
    if (!mgmt) {
      auditLog(request, { action: "rotate_manifest", success: false, errorCode: "unauthorized" });
      return sendV1Error(response, 401, "unauthorized", "Management token required");
    }
    const nextVersion = await rotateManifestTokenVersion(mgmt.configId);
    if (!nextVersion) {
      auditLog(request, { action: "rotate_manifest", configId: mgmt.configId, success: false, errorCode: "not_found" });
      return sendV1Error(response, 404, "not_found", "Config not found");
    }
    const token = await encodeConfigToken(mgmt.configId, nextVersion);
    const baseUrl = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
    auditLog(request, {
      action: "rotate_manifest", configId: mgmt.configId,
      authMethod: mgmt.usedLegacyAuth ? "legacy" : "management",
      extra: { new_version: nextVersion },
    });
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
    const mgmt = await resolveManagementAuth(request, url);
    if (!mgmt) {
      auditLog(request, { action: "rotate_management", success: false, errorCode: "unauthorized" });
      return sendV1Error(response, 401, "unauthorized", "Management token required");
    }
    const next = newManagementToken();
    const ok = await setManagementTokenHash(mgmt.configId, next.hash);
    if (!ok) {
      auditLog(request, { action: "rotate_management", configId: mgmt.configId, success: false, errorCode: "not_found" });
      return sendV1Error(response, 404, "not_found", "Config not found");
    }
    auditLog(request, {
      action: "rotate_management", configId: mgmt.configId,
      authMethod: mgmt.usedLegacyAuth ? "legacy" : "management",
    });
    return sendV1Json(response, 200, {
      config_id: mgmt.configId,
      management_token: next.raw,
      management_token_notice: "Save this immediately — it's shown only once. Required for future edits / rotations.",
    });
  }

  // GET /api/v1/configs/me/export — full config dump including every stored
  // credential in plaintext. For GDPR data-portability requests and for users
  // who want a local backup of their setup. Management-token-only — reading
  // your own raw debrid API key is the most sensitive operation in the API,
  // so a leaked manifest URL must not be able to trigger it.
  if (request.method === "GET" && url.pathname === "/api/v1/configs/me/export") {
    const mgmt = await resolveManagementAuth(request, url);
    if (!mgmt) {
      auditLog(request, { action: "config_export", success: false, errorCode: "unauthorized" });
      return sendV1Error(response, 401, "unauthorized", "Management token required");
    }
    auditLog(request, {
      action: "config_export", configId: mgmt.configId,
      authMethod: mgmt.usedLegacyAuth ? "legacy" : "management",
    });
    // No redaction here — the point is to give the owner their data back.
    // Content-Disposition header makes browsers save it as a file.
    response.setHeader("content-disposition", `attachment; filename="panda-config-${mgmt.configId}.json"`);
    return sendV1Json(response, 200, {
      exported_at: new Date().toISOString(),
      config_id: mgmt.configId,
      config: mgmt.record.config,
      created_at: mgmt.record.createdAt,
      updated_at: mgmt.record.updatedAt,
      notice: "This file contains your raw debrid API keys, Usenet password, and any other credentials you've provided. Treat it like a password file — do not commit to a repo, do not email, do not share.",
    });
  }

  // POST /api/v1/configs/me/purge — hard delete + audit-log scrub for GDPR
  // right-to-be-forgotten requests. Beyond a normal DELETE, this also strips
  // the config_id from every audit log entry for that config so no residual
  // trace of the customer's activity remains. Keep the log rows themselves
  // (for aggregate forensic value) but null out the config_id / IP / UA.
  if (request.method === "POST" && url.pathname === "/api/v1/configs/me/purge") {
    const mgmt = await resolveManagementAuth(request, url);
    if (!mgmt) {
      auditLog(request, { action: "config_purge", success: false, errorCode: "unauthorized" });
      return sendV1Error(response, 401, "unauthorized", "Management token required");
    }
    const configId = mgmt.configId;
    await deleteConfig(configId);
    // Emit the audit event FIRST so the scrub also scrubs it — a purge is
    // itself a thing that happened, but if we logged it after, we'd leave
    // a trailing record of the very event we're trying to erase.
    auditLog(request, {
      action: "config_purge", configId, authMethod: mgmt.usedLegacyAuth ? "legacy" : "management",
    });
    try {
      const { purgeAuditLogForConfig } = await import("../lib/audit.js");
      const purged = await purgeAuditLogForConfig(configId);
      return sendV1Json(response, 200, { deleted: true, audit_entries_scrubbed: purged });
    } catch (err) {
      // Config is gone either way; audit scrub failure is non-fatal.
      return sendV1Json(response, 200, { deleted: true, audit_entries_scrubbed: null, audit_scrub_error: err.message });
    }
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

async function handleCreateConfig(request, response, providers, parsedUrl = null) {
  const body = await readJsonBody(request);
  if (body == null) return sendV1Error(response, 400, "invalid_json", "Body must be JSON");

  // Create flow has no prior config to merge against; any "[redacted]"
  // placeholders get blanked so sanitizeConfig applies defaults.
  const config = sanitizeConfig(stripRedactionMarkers(body), providers);

  // Two paths:
  // A) Caller is authenticated as a Torve user (Bearer JWT or ?torve_token=).
  //    Record owner_torve_user_id and skip minting a management_token. The
  //    Torve account becomes the management credential. No "save this once"
  //    UX problem; new device just signs into Torve and manages.
  // B) Anonymous/standalone caller. Mint a management_token and return it
  //    once, exactly as before. Preserves Panda's standalone-Stremio-addon
  //    use case for non-Torve users.
  const torveAuth = verifyTorveJwtFromRequest(request, parsedUrl);

  let mgmt = null;
  let saveOpts;
  if (torveAuth) {
    saveOpts = { managementTokenHash: null, ownerTorveUserId: torveAuth.userId };
  } else {
    mgmt = newManagementToken();
    saveOpts = { managementTokenHash: mgmt.hash };
  }

  const record = await saveConfig(config, saveOpts);
  const token = await encodeConfigToken(record.id, record.manifestTokenVersion || 1);
  const baseUrl = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
  auditLog(request, {
    action: "config_create",
    configId: record.id,
    authMethod: torveAuth ? "torve_account" : "anonymous",
  });

  const payload = {
    config_id: record.id,
    panda_token: token,
    manifest_url: `${baseUrl}/u/${token}/manifest.json`,
    expires_at: null,
  };
  if (mgmt) {
    payload.management_token = mgmt.raw;
    payload.management_token_notice = "Save this management token now — it's shown only once and is required to edit or delete this config later.";
  } else {
    payload.account_managed = true;
    payload.account_managed_notice = "This config is bound to your Torve account. Sign in to Torve on any device to manage it. No management token is required.";
  }
  return sendV1Json(response, 200, payload);
}

// ── Secret reveal (owner-only plaintext read) ────────────────────────────

const REVEAL_HOURLY_LIMIT = 30;
const REVEAL_DAILY_LIMIT = 200;

/**
 * Classify the Authorization Bearer presented on the secret-reveal call,
 * without ever returning a plaintext secret based on a wrong token. The
 * auth matrix demanded by the Torve clients team distinguishes three
 * failure modes that the existing resolveManagementAuth conflates:
 *
 *   - Torve JWT (3 dot-separated segments) → verify; valid ⇒ jwt_valid,
 *                                            invalid/expired ⇒ jwt_invalid
 *   - Manifest token (1 dot)               → manifest
 *   - Management token (no dots, opaque)   → mgmt
 *   - Anything else / missing              → missing
 *
 * Manifest and missing/malformed → 401, mgmt → 403, jwt_invalid → 401,
 * jwt_valid → owner-check then 200/403.
 */
function _classifyBearerForReveal(request) {
  const auth = request.headers["authorization"] || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return { kind: "missing" };
  const tok = match[1].trim();
  if (!tok) return { kind: "missing" };
  const dots = (tok.match(/\./g) || []).length;
  if (dots === 0) return { kind: "mgmt" };
  if (dots === 1) return { kind: "manifest" };
  if (dots === 2) {
    // Inline-verify so we don't fall back to the query-string variant —
    // ?torve_token= MUST NOT authorize secret reveals (the manifest URL
    // is the most common channel for accidental token leakage).
    const verified = verifyTorveJwt(tok);
    if (verified) return { kind: "jwt_valid", userId: verified.userId };
    return { kind: "jwt_invalid" };
  }
  return { kind: "missing" };
}

function _writeRevealResponse(response, statusCode, body) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
  });
  response.end(JSON.stringify(body));
}

function _clientIp(request) {
  return (
    request.headers["x-real-ip"] ||
    (request.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    request.socket?.remoteAddress ||
    null
  );
}

async function handleRevealSecrets(request, response) {
  const featureEnabled = (process.env.PANDA_REVEAL_SECRETS_ENABLED || "true").toLowerCase() !== "false";
  if (!featureEnabled) {
    _writeRevealResponse(response, 404, { code: "not_found", message: "Endpoint disabled." });
    return;
  }

  const ip = _clientIp(request);
  const userAgent = request.headers["user-agent"] || null;
  const configId = request.headers["x-panda-config-id"];

  // 400: required header missing. We don't even know who's calling, so
  // the audit row goes in with NULL torve_user_id.
  if (!configId || typeof configId !== "string") {
    await auditSecretReveal({ torveUserId: null, configId: null, result: "bad_request", ip, userAgent });
    _writeRevealResponse(response, 400, { code: "bad_request", message: "X-Panda-Config-Id header required." });
    return;
  }

  const cls = _classifyBearerForReveal(request);

  // 401: no bearer / manifest token / invalid (incl. expired) JWT.
  if (cls.kind === "missing" || cls.kind === "manifest" || cls.kind === "jwt_invalid") {
    await auditSecretReveal({ torveUserId: null, configId, result: "unauthorized", ip, userAgent });
    _writeRevealResponse(response, 401, { code: "unauthorized", message: "Torve account authentication required." });
    return;
  }

  // 403: management token is real auth but wrong kind for this endpoint.
  if (cls.kind === "mgmt") {
    await auditSecretReveal({ torveUserId: null, configId, result: "forbidden", ip, userAgent });
    _writeRevealResponse(response, 403, { code: "forbidden", message: "Management token cannot read secrets. Use a Torve account JWT." });
    return;
  }

  // From here we have cls.kind === "jwt_valid" + cls.userId.
  const torveUserId = cls.userId;

  // Rate limit before owner check — distinguishes "you're flooding" from
  // "config not yours". Successful reveals only burn quota, but we charge
  // the user even on a forthcoming forbidden so that scanning every
  // config_id for ownership doesn't get a free pass. The 429 is returned
  // before doing the owner lookup so attackers can't enumerate.
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const hourlyOk = await countSecretRevealSuccesses(torveUserId, oneHourAgo);
  if (hourlyOk >= REVEAL_HOURLY_LIMIT) {
    await auditSecretReveal({ torveUserId, configId, result: "rate_limited", ip, userAgent });
    response.setHeader("retry-after", "60");
    _writeRevealResponse(response, 429, { code: "rate_limited", message: "Too many secret reads. Try again in a minute." });
    return;
  }
  const dailyOk = await countSecretRevealSuccesses(torveUserId, oneDayAgo);
  if (dailyOk >= REVEAL_DAILY_LIMIT) {
    await auditSecretReveal({ torveUserId, configId, result: "rate_limited", ip, userAgent });
    response.setHeader("retry-after", "3600");
    _writeRevealResponse(response, 429, { code: "rate_limited", message: "Daily secret-read limit reached. Try again tomorrow." });
    return;
  }

  // Owner check.
  const record = await getConfigRecord(configId);
  if (!record || !record.ownerTorveUserId || record.ownerTorveUserId !== torveUserId) {
    await auditSecretReveal({ torveUserId, configId, result: "forbidden", ip, userAgent });
    _writeRevealResponse(response, 403, { code: "forbidden", message: "Not the owner of this config." });
    return;
  }

  // Success — return plaintext. record.config is already decrypted by
  // getConfigRecord (decryptConfigFromStorage is applied there).
  const cfg = record.config || {};
  const indexers = Array.isArray(cfg.nzbIndexers) ? cfg.nzbIndexers : [];
  const body = {
    config_id: configId,
    debrid_api_key: cfg.debridApiKey || "",
    putio_client_id: cfg.putioClientId || "",
    usenet_password: cfg.usenetPassword || "",
    download_client_api_key: cfg.downloadClientApiKey || "",
    download_client_password: cfg.downloadClientPassword || "",
    nzb_indexer_api_key: cfg.nzbIndexerApiKey || "",
    nzb_indexers: indexers.map((r) => ({
      type: r?.type || "",
      url: r?.url || "",
      api_key: r?.apiKey || "",
    })),
  };
  await auditSecretReveal({ torveUserId, configId, result: "ok", ip, userAgent });
  _writeRevealResponse(response, 200, body);
}

async function handleConfigMe(request, response, providers, parsedUrl = null) {
  // GET is read-only: the manifest token alone suffices. PATCH / DELETE are
  // mutating and require the management token (sha256-hash-matched) so that a
  // leaked stream URL can't be used to tamper with credentials.
  if (request.method === "GET") {
    // Read-only, so accept EITHER token. Manifest-token path is used by
    // the normal "open my config for editing" flow; management-token path
    // is used by the client's recovery flow to validate a pasted admin-
    // issued token before storing it. Either way the response is secret-
    // redacted, so this widens accessibility without leaking anything.
    const mgmt = await resolveManagementAuth(request, parsedUrl);
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

  const mgmt = await resolveManagementAuth(request, parsedUrl);
  if (!mgmt) {
    auditLog(request, {
      action: request.method === "DELETE" ? "config_delete" : "config_patch",
      success: false, errorCode: "unauthorized",
    });
    return sendV1Error(
      response, 401, "unauthorized",
      "This operation requires the management token.",
    );
  }
  const { configId, record, usedLegacyAuth } = mgmt;
  const authMethod = usedLegacyAuth ? "legacy" : "management";

  if (request.method === "PATCH") {
    const body = await readJsonBody(request);
    if (body == null) {
      auditLog(request, { action: "config_patch", configId, authMethod, success: false, errorCode: "invalid_json" });
      return sendV1Error(response, 400, "invalid_json", "Body must be JSON");
    }
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
    // fields_changed records which top-level keys the body attempted to
    // overwrite — useful for ops (detect an account being tampered with)
    // without ever logging the values themselves.
    auditLog(request, {
      action: "config_patch", configId, authMethod,
      fieldsChanged: Object.keys(body || {}).filter((k) => k !== "integration_type"),
    });
    return sendV1Json(response, 200, {
      config_id: configId,
      config: redactConfigSecrets(updated.config),
      updated_at: updated.updatedAt,
      used_legacy_auth: usedLegacyAuth || undefined,
    });
  }

  if (request.method === "DELETE") {
    await deleteConfig(configId);
    auditLog(request, { action: "config_delete", configId, authMethod });
    return sendV1Json(response, 200, { deleted: true });
  }

  return sendV1Error(response, 405, "method_not_allowed", `Method ${request.method} not supported`);
}
