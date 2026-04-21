import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { decodeConfigToken, encodeConfigToken } from "./config/config-token.js";
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
} from "./config/schema.js";
import { getConfigRecord, redactConfigSecrets, saveConfig, stripRedactionMarkers } from "./config/config-store.js";
import { auditLog } from "./lib/audit.js";
import { getProviderRegistry } from "./providers/provider-registry.js";
import { buildStreams } from "./streams/pipeline.js";
import { getCachedEasynewsCdnUrl } from "./providers/usenet-adapter.js";
import { renderConfigPage } from "./ui/config-page.js";
import { tryHandleV1 } from "./api/v1.js";

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || "0.0.0.0";
const providers = getProviderRegistry();

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendSvg(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=3600"
  });
  response.end(body);
}

function notFound(response) {
  sendJson(response, 404, { error: "not_found" });
}

function getBaseUrl(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProto === "string" ? forwardedProto : "http";
  return `${protocol}://${request.headers.host}`;
}

function createManifest(baseUrl, config, token) {
  const configured = config.enabledProviders.length > 0;
  const nameSuffix = configured ? "Configured" : "Setup";

  return {
    id: "com.torve.panda",
    version: "0.2.0",
    name: `Panda (${nameSuffix})`,
    description: "Torve guided streaming addon with server-side debrid storage and Torrentio-backed source orchestration.",
    logo: `${baseUrl}/logo.png`,
    background: `${baseUrl}/logo.png`,
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: !configured
    },
    links: [
      {
        name: "Configure Panda",
        url: `${baseUrl}/configure`
      }
    ],
    config: token
      ? [
          {
            key: "configured_manifest",
            type: "text",
            title: `${baseUrl}/u/${token}/manifest.json`
          }
        ]
      : [
          {
            key: "configure",
            type: "text",
            title: "Use /configure for the guided setup flow."
          }
        ]
  };
}

function renderHome(baseUrl) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Panda - Torve</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
      :root {
        color-scheme: dark;
        --bg: #08080e;
        --bg-card: #111118;
        --line: rgba(255,255,255,.1);
        --text: #e4e4e7;
        --text-strong: #ffffff;
        --muted: #71717a;
        --accent: #c8a44e;
        --radius: 10px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg);
        color: var(--text);
        -webkit-font-smoothing: antialiased;
      }
      .site-header {
        background: rgba(8,8,14,.85);
        border-bottom: 1px solid var(--line);
      }
      .site-header-inner {
        max-width: 1140px; margin: 0 auto;
        padding: 14px 20px;
        display: flex; align-items: center; gap: 20px;
      }
      .brand { font-weight: 700; color: var(--text-strong); text-decoration: none; }
      main { max-width: 760px; margin: 0 auto; padding: 40px 20px; }
      h1 { font-size: 36px; font-weight: 700; color: var(--text-strong); letter-spacing: -.02em; margin: 0 0 8px; }
      p { color: var(--muted); line-height: 1.6; }
      .card { background: var(--bg-card); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 24px; margin-top: 20px; }
      ul { list-style: none; padding: 0; margin: 0; }
      li { padding: 10px 0; border-bottom: 1px solid var(--line); }
      li:last-child { border-bottom: none; }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      code { background: var(--bg); border: 1px solid var(--line); padding: 2px 6px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; color: var(--text-strong); }
    </style>
  </head>
  <body>
    <header class="site-header">
      <div class="site-header-inner">
        <a href="https://torve.app" class="brand">Torve / Panda</a>
      </div>
    </header>
    <main>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
        <img src="/logo.png" alt="Panda" style="width:72px;height:72px;border-radius:14px;flex-shrink:0">
        <h1 style="margin:0">Panda</h1>
      </div>
      <p>Panda is the Torve guided streaming addon service. Pick your sources, enter your credentials once, and Panda returns a single manifest URL you can install in Torve.</p>
      <div class="card">
        <ul>
          <li><a href="/configure">→ Guided setup</a></li>
          <li><a href="https://torve.app/app/extensions.html">← Back to Torve extensions</a></li>
          <li><a href="/manifest.json">Base manifest</a></li>
          <li><a href="/healthz">Service health</a></li>
        </ul>
      </div>
      <p style="margin-top:20px;font-size:12px">Base URL: <code>${baseUrl}</code></p>
    </main>
  </body>
</html>`;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function getStoredConfigOrNull(token) {
  const decoded = await decodeConfigToken(token);
  if (!decoded) return null;

  const record = await getConfigRecord(decoded.configId);
  if (!record) return null;

  // Enforce manifest-token rotation: tokens signed before a rotate call
  // carry a tokenVersion older than the config's current manifestTokenVersion.
  // Reject them so a leaked manifest URL can be revoked.
  const currentVersion = record.manifestTokenVersion || 1;
  if (decoded.tokenVersion !== currentVersion) return null;

  return record;
}

const server = http.createServer(async (request, response) => {
  try {
    const baseUrl = getBaseUrl(request);
    const url = new URL(request.url || "/", baseUrl);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, 200, renderHome(baseUrl));
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, {
        ok: true,
        service: "panda",
        providers: providers.length
      });
      return;
    }

    // v1 API (mobile clients)
    if (await tryHandleV1(request, response, url, providers)) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/manifest.json") {
      sendJson(response, 200, createManifest(baseUrl, createDefaultConfig(), null));
      return;
    }

    if (request.method === "GET" && url.pathname === "/logo.png") {
      const logoPath = new URL("./ui/panda-logo.png", import.meta.url);
      try {
        const fs = await import("node:fs");
        const data = fs.readFileSync(logoPath);
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": data.length,
          "cache-control": "public, max-age=86400",
        });
        response.end(data);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }

    // Favicon → use the same panda PNG
    if (request.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")) {
      const logoPath = new URL("./ui/panda-logo.png", import.meta.url);
      try {
        const fs = await import("node:fs");
        const data = fs.readFileSync(logoPath);
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": data.length,
          "cache-control": "public, max-age=86400",
        });
        response.end(data);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/logo.svg") {
      sendSvg(
        response,
        200,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Panda">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#11161d"/>
              <stop offset="100%" stop-color="#1d2b35"/>
            </linearGradient>
          </defs>
          <rect width="128" height="128" rx="28" fill="url(#g)"/>
          <circle cx="64" cy="68" r="34" fill="#f5f7fa"/>
          <circle cx="45" cy="40" r="12" fill="#1a2028"/>
          <circle cx="83" cy="40" r="12" fill="#1a2028"/>
          <ellipse cx="51" cy="66" rx="8" ry="11" fill="#1a2028"/>
          <ellipse cx="77" cy="66" rx="8" ry="11" fill="#1a2028"/>
          <circle cx="64" cy="80" r="6" fill="#1a2028"/>
          <path d="M54 90c4 5 16 5 20 0" fill="none" stroke="#1a2028" stroke-width="5" stroke-linecap="round"/>
          <path d="M22 108h84" stroke="#ffb74d" stroke-width="8" stroke-linecap="round"/>
        </svg>`
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/configure") {
      sendHtml(
        response,
        200,
        renderConfigPage({
          baseUrl,
          providers,
          config: createDefaultConfig(),
          qualityOptions: QUALITY_OPTIONS,
          qualityProfiles: QUALITY_PROFILES,
          debridServices: DEBRID_SERVICES,
          releaseLanguages: RELEASE_LANGUAGES,
          sortOptions: SORT_OPTIONS,
          resultLimits: RESULT_LIMITS,
          usenetProviders: USENET_PROVIDERS,
          nzbIndexers: NZB_INDEXERS,
          downloadClients: DOWNLOAD_CLIENTS
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/configs") {
      const body = await readJsonBody(request);
      // If the web UI re-saved a prior config, the body may contain
      // "[redacted]" markers for every secret. Strip them so sanitizeConfig
      // doesn't store the placeholder literal as the credential.
      const config = sanitizeConfig(stripRedactionMarkers(body), providers);
      // Same two-token model as /api/v1/configs. Management token shown once,
      // hash persisted. Needed for future PATCH / DELETE / rotate calls.
      const mgmtRaw = crypto.randomBytes(32).toString("hex");
      const mgmtHash = crypto.createHash("sha256").update(mgmtRaw).digest("hex");
      const record = await saveConfig(config, { managementTokenHash: mgmtHash });
      const token = await encodeConfigToken(record.id, record.manifestTokenVersion || 1);
      auditLog(request, { action: "config_create", configId: record.id, extra: { via: "legacy_web_form" } });

      sendJson(response, 200, {
        token,
        configId: record.id,
        manifestUrl: `${baseUrl}/u/${token}/manifest.json`,
        managementToken: mgmtRaw,
        managementTokenNotice: "Save this token now — shown only once. Required to edit or delete the config later.",
      });
      return;
    }

    const manifestMatch = url.pathname.match(/^\/u\/([^/]+)\/manifest\.json$/);
    if (request.method === "GET" && manifestMatch) {
      const record = await getStoredConfigOrNull(manifestMatch[1]);
      if (!record) {
        sendJson(response, 404, { error: "config_not_found" });
        return;
      }

      sendJson(response, 200, createManifest(baseUrl, record.config, manifestMatch[1]));
      return;
    }

    const streamMatch = url.pathname.match(/^\/u\/([^/]+)\/stream\/([^/]+)\/([^/]+)\.json$/);
    if (request.method === "GET" && streamMatch) {
      const [, token, mediaType, mediaId] = streamMatch;
      const record = await getStoredConfigOrNull(token);
      if (!record) {
        sendJson(response, 404, { error: "config_not_found", streams: [] });
        return;
      }

      const result = await buildStreams({
        config: record.config,
        mediaType,
        mediaId,
        proxyBaseUrl: `${baseUrl}/u/${token}`,
      });
      sendJson(response, 200, { streams: result.streams });
      return;
    }

    // Easynews proxy — streams content through Panda so the client doesn't need embedded auth.
    // Supports GET + HEAD, forwards Range headers for seekable playback.
    const easynewsMatch = url.pathname.match(/^\/u\/([^/]+)\/easynews\/([^/]+)\/(.+)$/);
    if ((request.method === "GET" || request.method === "HEAD") && easynewsMatch) {
      const [, token, hash, filename] = easynewsMatch;
      const record = await getStoredConfigOrNull(token);
      if (!record || record.config.usenetProvider !== "easynews") {
        sendJson(response, 404, { error: "config_not_found" });
        return;
      }

      const { usenetUsername, usenetPassword } = record.config;
      // Prefer a pre-resolved signed CDN URL (warmed at search time). When the
      // stream list was built, Panda did the /dl/ 302 resolution and stored
      // the resulting CDN URL in-process. Going direct to that URL skips the
      // redirect round-trip AND hits the same CDN node that was warmed — the
      // player typically sees ~100ms TTFB instead of the 100s cold-start on
      // the canonical /dl/ endpoint.
      const cachedCdnUrl = getCachedEasynewsCdnUrl(hash);
      const easynewsUrl = cachedCdnUrl
        || `https://members.easynews.com/dl/${hash}/${filename}`;
      const auth = Buffer.from(`${usenetUsername}:${usenetPassword}`).toString("base64");

      // Forward Range header so clients can seek. Only attach Basic auth when
      // we're hitting the canonical /dl/ endpoint — the signed CDN URL is
      // self-authenticating and rejects extraneous Authorization headers.
      //
      // Easynews's CDN returns HTTP 400 if no Range header is present on GET
      // requests for large files. ExoPlayer's initial GET may not send one,
      // so inject `bytes=0-` when the client didn't specify a range. This
      // lets the upstream succeed and the full response stream flows through.
      const fwdHeaders = {};
      if (!cachedCdnUrl) fwdHeaders["Authorization"] = `Basic ${auth}`;
      fwdHeaders["Range"] = request.headers["range"] || "bytes=0-";
      if (request.headers["user-agent"]) fwdHeaders["User-Agent"] = request.headers["user-agent"];

      try {
        // Easynews returns 416 while a cold file is still being prepared on
        // the CDN node (the sig is valid, but no bytes are available yet).
        // ExoPlayer treats 416 as fatal and stops, so we absorb the prep
        // wait here. 12 × 2.5s ≈ 30s covers ~98% of cold-starts while not
        // hanging the client for a full minute on genuinely unavailable files.
        const MAX_ATTEMPTS = 12;
        const BACKOFF_MS = 2500;
        let upstream;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          upstream = await fetch(easynewsUrl, {
            method: request.method,
            headers: fwdHeaders,
            redirect: "follow",
          });
          if (upstream.status !== 416) break;
          try { upstream.body?.cancel(); } catch {}
          if (attempt === MAX_ATTEMPTS) break;
          await new Promise(r => setTimeout(r, BACKOFF_MS));
        }

        // Build response headers from upstream, preserving partial-content semantics
        const respHeaders = { "cache-control": "no-store" };
        for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
          const v = upstream.headers.get(h);
          if (v) respHeaders[h] = v;
        }
        if (!respHeaders["accept-ranges"]) respHeaders["accept-ranges"] = "bytes";

        response.writeHead(upstream.status, respHeaders);

        if (request.method === "HEAD" || !upstream.body) {
          response.end();
          return;
        }

        // fetch() returns a WHATWG ReadableStream. Convert to a Node Readable
        // and pipe. Use the stream module to support backpressure.
        const { Readable } = await import("node:stream");
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.pipe(response);
        nodeStream.on("error", (err) => {
          _log?.debug?.("easynews pipe error:", err.message);
          try { response.end(); } catch {}
        });
        response.on("close", () => {
          try { nodeStream.destroy(); } catch {}
        });
      } catch (err) {
        if (!response.headersSent) {
          sendJson(response, 502, { error: "easynews_proxy_error", message: err.message });
        }
      }
      return;
    }

    const debugMatch = url.pathname.match(/^\/debug\/config\/([^/]+)$/);
    if (request.method === "GET" && debugMatch) {
      const record = await getStoredConfigOrNull(debugMatch[1]);
      if (!record) {
        sendJson(response, 404, { error: "config_not_found" });
        return;
      }

      sendJson(response, 200, {
        id: record.id,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        config: redactConfigSecrets(record.config)
      });
      return;
    }

    notFound(response);
  } catch (error) {
    console.error("Request handler error:", error?.stack || error);
    // If a streaming handler already wrote headers (common for the easynews
    // proxy piping Range responses), we can't send a JSON error — just
    // close the socket and move on. Previously this path throws
    // ERR_HTTP_HEADERS_SENT and crashes the whole server.
    if (response.headersSent) {
      try { response.end(); } catch { /* ignore */ }
      return;
    }
    try {
      sendJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown server error"
      });
    } catch { /* swallow — already handled as best we can */ }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Panda listening on http://${HOST}:${PORT}`);
});
