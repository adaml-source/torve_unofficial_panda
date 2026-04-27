/**
 * Verify a Torve access token (JWT, HS256) against the shared TORVE_JWT_SECRET.
 *
 * This is intentionally tiny and dependency-free — it does *only* what Panda
 * needs: HS256 signature verification + exp check + sub extraction. Anything
 * fancier (key rotation, JWKS, RS256) gets added when there's a reason to.
 *
 * Returns { userId } on success, null on any failure (bad shape, bad sig,
 * expired, missing sub). Never throws.
 *
 * The shared secret is read from the TORVE_JWT_SECRET env var. Same value
 * as torve-backend's JWT_SECRET — both services run on the same host and
 * are operated by the same person, so a shared HMAC secret is fine. If
 * the env var is missing, every call fails closed (returns null).
 */

import crypto from "node:crypto";

const ALGO = "HS256";

function base64UrlDecode(str) {
  return Buffer.from(str, "base64url").toString();
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyTorveJwt(token) {
  if (!token || typeof token !== "string") return null;
  const secret = process.env.TORVE_JWT_SECRET || "";
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  // Header: confirm algorithm matches what we'll verify with.
  let header;
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    return null;
  }
  if (!header || header.alg !== ALGO || header.typ !== "JWT") return null;

  // Verify signature.
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  if (!timingSafeEq(expectedSig, sigB64)) return null;

  // Decode + validate payload.
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;
  return { userId: sub, payload };
}

/**
 * Extract a Torve JWT from a request — first checking the `Authorization:
 * Bearer ...` header, then the `?torve_token=` query string. Returns the
 * verified payload or null. The query-string fallback is what lets the
 * Panda configure page receive auth via a redirect from torve.app — direct
 * browser navigations can't easily set custom headers.
 */
export function verifyTorveJwtFromRequest(request, parsedUrl = null) {
  const auth = request.headers["authorization"] || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) {
    const candidate = match[1].trim();
    // Distinguish a Torve JWT (three dot-separated base64url segments)
    // from Panda's own management token (opaque hex, no dots) so we don't
    // accidentally treat one as the other.
    if (candidate.split(".").length === 3) {
      const verified = verifyTorveJwt(candidate);
      if (verified) return verified;
    }
  }
  if (parsedUrl) {
    const qs = parsedUrl.searchParams.get("torve_token");
    if (qs) {
      const verified = verifyTorveJwt(qs);
      if (verified) return verified;
    }
  }
  return null;
}
