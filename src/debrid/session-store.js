/**
 * In-memory session store for pending OAuth device flows.
 *
 * Sessions are short-lived (minutes) and never need persistence across
 * restarts — if the server restarts mid-flow the user just retries.
 *
 * Each session key is a random 32-char id returned to the client as
 * `device_code`. The client must send it back when polling. We hide the
 * actual provider device_code behind our own id so clients don't depend
 * on provider-specific formats.
 */
import crypto from "node:crypto";

const SESSIONS = new Map();  // panda_device_code -> session
const SESSION_TTL_MS = 30 * 60 * 1000;  // 30 minutes max

function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function cleanupExpired() {
  const now = Date.now();
  for (const [key, session] of SESSIONS) {
    if (session.expires_at < now) SESSIONS.delete(key);
  }
}

/**
 * @param {string} providerId
 * @param {object} providerResult  output from startDeviceFlow()
 * @returns {object} with our own device_code + user-facing fields
 */
export function createSession(providerId, providerResult) {
  cleanupExpired();
  const pandaCode = newId();
  const now = Date.now();
  const ttlSec = Math.min(providerResult.expires_in || 900, SESSION_TTL_MS / 1000);
  SESSIONS.set(pandaCode, {
    provider_id: providerId,
    provider_device_code: providerResult.device_code,
    provider_extras: providerResult.provider_extras || null,
    user_code: providerResult.user_code,
    verification_url: providerResult.verification_url,
    interval: providerResult.interval || 5,
    created_at: now,
    expires_at: now + ttlSec * 1000
  });
  return {
    device_code: pandaCode,
    user_code: providerResult.user_code,
    verification_url: providerResult.verification_url,
    expires_in: ttlSec,
    interval: providerResult.interval || 5
  };
}

export function getSession(pandaCode) {
  cleanupExpired();
  return SESSIONS.get(pandaCode) || null;
}

export function deleteSession(pandaCode) {
  SESSIONS.delete(pandaCode);
}

export function _testReset() {
  SESSIONS.clear();
}
