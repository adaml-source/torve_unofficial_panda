// Sentry initialisation for Panda.
//
// No-op when PANDA_SENTRY_DSN is unset — the module still imports
// cleanly, init() returns without doing anything, no telemetry leaves
// the process. To activate: set PANDA_SENTRY_DSN in /opt/panda/.env
// and restart the service.
//
// Call init() once, as early as possible, before the server starts
// listening — this is how @sentry/node hooks into the http module.

import * as Sentry from "@sentry/node";

let initialised = false;

export function init() {
  if (initialised) return;
  const dsn = (process.env.PANDA_SENTRY_DSN || "").trim();
  if (!dsn) return;

  const environment = (process.env.PANDA_SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production").trim();
  const release = (process.env.PANDA_SENTRY_RELEASE || "").trim() || undefined;
  const tracesSampleRate = Number(process.env.PANDA_SENTRY_TRACES_SAMPLE_RATE || "0");

  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate,
    // No PII. Panda handles credentials; we do not want them in events.
    sendDefaultPii: false,
    // Belt-and-suspenders: if something accidentally sticks a key/token
    // into a breadcrumb string, this scrubs the most common patterns.
    beforeSend(event) {
      return scrubEvent(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
    },
  });

  initialised = true;
  // stdout so systemd journal picks it up regardless of logger state.
  console.log(`Sentry initialised env=${environment}`);
}

// Redact Bearer tokens, URL query params commonly holding API keys, and
// our own ciphertext prefix if it ever shows up verbatim in an event.
const REDACTION_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]"],
  [/([?&](?:token|apikey|api_key|key|auth)=)[^&\s"']+/gi, "$1[REDACTED]"],
  [/v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*/g, "v1:[REDACTED]"],
];

function redactString(s) {
  if (typeof s !== "string") return s;
  let out = s;
  for (const [re, repl] of REDACTION_PATTERNS) out = out.replace(re, repl);
  return out;
}

function scrubEvent(event) {
  try {
    if (event.message) event.message = redactString(event.message);
    const exVals = event.exception?.values;
    if (Array.isArray(exVals)) {
      for (const ex of exVals) if (ex.value) ex.value = redactString(ex.value);
    }
  } catch { /* swallow — never let scrubbing break the outgoing event */ }
  return event;
}

function scrubBreadcrumb(breadcrumb) {
  try {
    if (breadcrumb.message) breadcrumb.message = redactString(breadcrumb.message);
    if (breadcrumb.data && typeof breadcrumb.data === "object") {
      for (const k of Object.keys(breadcrumb.data)) {
        if (typeof breadcrumb.data[k] === "string") {
          breadcrumb.data[k] = redactString(breadcrumb.data[k]);
        }
      }
    }
  } catch { /* swallow */ }
  return breadcrumb;
}

// Re-export capture helpers so callers don't need to import @sentry/node
// directly — cleaner boundary and easier to swap later.
export const captureException = (err, ctx) => Sentry.captureException(err, ctx);
export const captureMessage = (msg, level) => Sentry.captureMessage(msg, level);
export const flush = (timeoutMs = 2000) => Sentry.flush(timeoutMs);
