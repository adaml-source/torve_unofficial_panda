/**
 * OAuth device-flow implementation per provider.
 *
 * Each provider exposes:
 *   startDeviceFlow()       -> { device_code, user_code, verification_url, expires_in, interval, provider_extras }
 *   pollDeviceFlow(device_code, provider_extras) -> { status, token?, error_message? }
 *   validateApiKey(key)     -> { valid, display_identifier?, error_message? }
 *
 * Uses fetch (global, Node 22+). No external deps.
 */
import { getProvider } from "./providers.js";

const DEFAULT_TIMEOUT_MS = 15_000;

async function httpJson(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

// ── Real-Debrid device flow ───────────────────────────────────────────
// 1. POST /device/code -> device_code, user_code, verification_url
// 2. Poll /device/credentials?device_code=... -> returns client_id + client_secret when authorized
// 3. POST /token with new client_id/secret -> returns access_token

async function rdStart() {
  const p = getProvider("realdebrid");
  const url = new URL(p.oauth.deviceCodeUrl);
  url.searchParams.set("client_id", p.oauth.clientId);
  url.searchParams.set("new_credentials", "yes");
  const res = await httpJson(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error(`real_debrid_device_code_failed_${res.status}`);
  const d = res.data;
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_url: d.verification_url,
    expires_in: d.expires_in,
    interval: d.interval || 5,
    provider_extras: null
  };
}

async function rdPoll(device_code) {
  const p = getProvider("realdebrid");
  // Phase 1: check for credentials
  const credsUrl = new URL(p.oauth.credentialsUrl);
  credsUrl.searchParams.set("client_id", p.oauth.clientId);
  credsUrl.searchParams.set("code", device_code);
  const credsRes = await httpJson(credsUrl.toString(), { method: "GET" });
  if (credsRes.status === 403) {
    // Not yet authorized
    return { status: "pending" };
  }
  if (!credsRes.ok) {
    if (credsRes.data?.error === "expired_token") return { status: "expired" };
    return { status: "pending" };
  }
  const { client_id, client_secret } = credsRes.data || {};
  if (!client_id || !client_secret) return { status: "pending" };

  // Phase 2: exchange for access token
  const body = new URLSearchParams({
    client_id,
    client_secret,
    code: device_code,
    grant_type: "http://oauth.net/grant_type/device/1.0"
  });
  const tokenRes = await httpJson(p.oauth.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!tokenRes.ok) return { status: "pending" };
  const { access_token } = tokenRes.data || {};
  if (!access_token) return { status: "pending" };

  return { status: "approved", token: access_token };
}

async function rdValidateApiKey(apiKey) {
  const p = getProvider("realdebrid");
  const res = await httpJson(p.apikeyValidateUrl, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) return { valid: false, error_message: "Invalid Real-Debrid API key" };
  return { valid: true, display_identifier: res.data?.username || res.data?.email || null };
}

// ── Premiumize device flow ────────────────────────────────────────────
// Standard RFC 8628 device flow.

async function pmStart() {
  const p = getProvider("premiumize");
  const body = new URLSearchParams({
    client_id: p.oauth.clientId,
    response_type: "device_code"
  });
  const res = await httpJson(p.oauth.deviceCodeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`premiumize_device_code_failed_${res.status}`);
  const d = res.data;
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_url: d.verification_uri || d.verification_url,
    expires_in: d.expires_in,
    interval: d.interval || 5,
    provider_extras: null
  };
}

async function pmPoll(device_code) {
  const p = getProvider("premiumize");
  const body = new URLSearchParams({
    client_id: p.oauth.clientId,
    code: device_code,
    grant_type: "device_code"
  });
  const res = await httpJson(p.oauth.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (res.ok && res.data?.access_token) {
    return { status: "approved", token: res.data.access_token };
  }
  const err = res.data?.error;
  if (err === "authorization_pending" || err === "slow_down") return { status: "pending" };
  if (err === "expired_token") return { status: "expired" };
  if (err === "access_denied") return { status: "denied" };
  return { status: "pending" };
}

async function pmValidateApiKey(apiKey) {
  const p = getProvider("premiumize");
  const url = `${p.apikeyValidateUrl}?apikey=${encodeURIComponent(apiKey)}`;
  const res = await httpJson(url);
  if (!res.ok || res.data?.status !== "success") {
    return { valid: false, error_message: "Invalid Premiumize API key" };
  }
  return { valid: true, display_identifier: res.data?.customer_id?.toString() || null };
}

// ── AllDebrid PIN flow ────────────────────────────────────────────────
// 1. GET /pin/get -> { pin, check, url, expires_in }
// 2. Poll /pin/check?check=...&pin=... -> { activated, apikey }

async function adStart() {
  const p = getProvider("alldebrid");
  const url = new URL(p.oauth.pinUrl);
  url.searchParams.set("agent", p.oauth.agent);
  const res = await httpJson(url.toString());
  if (!res.ok || res.data?.status !== "success") {
    throw new Error(`alldebrid_pin_failed_${res.status}`);
  }
  const d = res.data.data;
  return {
    device_code: d.check,  // we use AD's "check" token as our device_code
    user_code: d.pin,
    verification_url: d.user_url || d.base_url || "https://alldebrid.com/pin",
    expires_in: d.expires_in,
    interval: 5,
    provider_extras: { pin: d.pin }
  };
}

async function adPoll(device_code, provider_extras) {
  const p = getProvider("alldebrid");
  const url = new URL(p.oauth.checkUrl);
  url.searchParams.set("agent", p.oauth.agent);
  url.searchParams.set("check", device_code);
  url.searchParams.set("pin", provider_extras?.pin || "");
  const res = await httpJson(url.toString());
  if (!res.ok) return { status: "pending" };
  if (res.data?.status !== "success") {
    const code = res.data?.error?.code;
    if (code === "AUTH_PIN_EXPIRED") return { status: "expired" };
    return { status: "pending" };
  }
  const d = res.data.data;
  if (d.activated && d.apikey) {
    return { status: "approved", token: d.apikey };
  }
  if (d.expires_in <= 0) return { status: "expired" };
  return { status: "pending" };
}

async function adValidateApiKey(apiKey) {
  const p = getProvider("alldebrid");
  const url = `${p.apikeyValidateUrl}?agent=${encodeURIComponent(p.oauth.agent)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await httpJson(url);
  if (!res.ok || res.data?.status !== "success") {
    return { valid: false, error_message: "Invalid AllDebrid API key" };
  }
  return { valid: true, display_identifier: res.data?.data?.user?.username || null };
}

// ── TorBox API key only ───────────────────────────────────────────────

async function tbValidateApiKey(apiKey) {
  const p = getProvider("torbox");
  const res = await httpJson(p.apikeyValidateUrl, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok || res.data?.success === false) {
    return { valid: false, error_message: "Invalid TorBox API key" };
  }
  return { valid: true, display_identifier: res.data?.data?.email || res.data?.data?.id?.toString() || null };
}

// ── Dispatch ──────────────────────────────────────────────────────────

const START_FNS = {
  realdebrid: rdStart,
  premiumize: pmStart,
  alldebrid: adStart
};

const POLL_FNS = {
  realdebrid: rdPoll,
  premiumize: pmPoll,
  alldebrid: adPoll
};

const APIKEY_VALIDATORS = {
  realdebrid: rdValidateApiKey,
  premiumize: pmValidateApiKey,
  alldebrid: adValidateApiKey,
  torbox: tbValidateApiKey
};

export async function startDeviceFlow(providerId) {
  const fn = START_FNS[providerId];
  if (!fn) {
    const err = new Error("provider_oauth_unsupported");
    err.code = "provider_oauth_unsupported";
    throw err;
  }
  return await fn();
}

export async function pollDeviceFlow(providerId, device_code, provider_extras) {
  const fn = POLL_FNS[providerId];
  if (!fn) {
    const err = new Error("provider_oauth_unsupported");
    err.code = "provider_oauth_unsupported";
    throw err;
  }
  return await fn(device_code, provider_extras);
}

export async function validateApiKey(providerId, apiKey) {
  const fn = APIKEY_VALIDATORS[providerId];
  if (!fn) {
    return { valid: false, error_message: "Unsupported provider" };
  }
  return await fn(apiKey);
}
