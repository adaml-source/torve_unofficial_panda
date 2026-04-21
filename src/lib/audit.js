/**
 * Append-only audit log for config-management events.
 *
 * Writes one JSON line per event to /var/log/panda/audit.log (overridable
 * via PANDA_AUDIT_LOG env var). Deliberately not tied to stdout/stderr or
 * the journal — lets ops apply logrotate without touching application output
 * and lets compliance grep a single file with a known schema.
 *
 * Event schema:
 *   {
 *     ts: ISO-8601 UTC timestamp,
 *     action: "config_create" | "config_patch" | "config_delete"
 *           | "rotate_manifest" | "rotate_management",
 *     config_id: string,
 *     ip: string,                  // X-Forwarded-For chain's leftmost or remoteAddress
 *     user_agent: string|null,
 *     auth_method: "management" | "manifest" | "legacy" | null,
 *     success: bool,
 *     error_code: string|null,     // present only when success=false
 *     fields_changed: string[]|null,  // PATCH only — top-level keys touched
 *     extra: {...}|null
 *   }
 *
 * NEVER logs secrets — token values, passwords, API keys are forbidden.
 * Callers must only pass {config_id, auth_method, success, fields_changed}.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_PATH = process.env.PANDA_AUDIT_LOG || "/var/log/panda/audit.log";
let writeStream = null;

function ensureStream() {
  if (writeStream) return writeStream;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o750 });
    writeStream = fs.createWriteStream(LOG_PATH, { flags: "a", mode: 0o640 });
    writeStream.on("error", (err) => {
      // Don't crash the server if audit logging fails — fall back silently.
      console.error(`[panda-audit] write stream error: ${err.message}`);
      writeStream = null;
    });
  } catch (err) {
    console.error(`[panda-audit] failed to open ${LOG_PATH}: ${err.message}`);
    writeStream = null;
  }
  return writeStream;
}

function getClientIp(request) {
  const xff = request.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return request.socket?.remoteAddress || "";
}

/**
 * Emit an audit event. Fire-and-forget; callers shouldn't await.
 * Swallows errors (observability should never break the critical path).
 */
export function auditLog(request, event) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action: event.action,
      config_id: event.configId || null,
      ip: getClientIp(request),
      user_agent: request.headers?.["user-agent"] || null,
      auth_method: event.authMethod || null,
      success: event.success !== false,
      error_code: event.errorCode || null,
      fields_changed: event.fieldsChanged || null,
      extra: event.extra || null,
    }) + "\n";
    const stream = ensureStream();
    if (stream) stream.write(line);
  } catch {
    // never let audit logging break anything
  }
}
