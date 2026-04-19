import http from "node:http";
import { URL } from "node:url";
import { decodeConfigToken, encodeConfigToken } from "./config/config-token.js";
import {
  createDefaultConfig,
  DEBRID_SERVICES,
  QUALITY_OPTIONS,
  QUALITY_PROFILES,
  RELEASE_LANGUAGES,
  RESULT_LIMITS,
  sanitizeConfig,
  SORT_OPTIONS
} from "./config/schema.js";
import { getConfigRecord, redactConfigSecrets, saveConfig } from "./config/config-store.js";
import { getProviderRegistry } from "./providers/provider-registry.js";
import { buildStreams } from "./streams/pipeline.js";
import { renderConfigPage } from "./ui/config-page.js";

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
    logo: `${baseUrl}/logo.svg`,
    background: `${baseUrl}/logo.svg`,
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
    <title>Panda</title>
    <style>
      body {
        margin: 0;
        font-family: "Segoe UI", system-ui, sans-serif;
        background: #0d1117;
        color: #e6edf3;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 40px 20px;
      }
      a { color: #ffb74d; }
      code {
        background: #161b22;
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Panda</h1>
      <p>Panda is the Torve guided streaming addon service.</p>
      <ul>
        <li><a href="/configure">Guided setup</a></li>
        <li><a href="/manifest.json">Base manifest</a></li>
        <li><a href="/healthz">Health</a></li>
      </ul>
      <p>Base URL: <code>${baseUrl}</code></p>
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
  const configId = await decodeConfigToken(token);
  if (!configId) {
    return null;
  }

  return await getConfigRecord(configId);
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

    if (request.method === "GET" && url.pathname === "/manifest.json") {
      sendJson(response, 200, createManifest(baseUrl, createDefaultConfig(), null));
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
          resultLimits: RESULT_LIMITS
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/configs") {
      const body = await readJsonBody(request);
      const config = sanitizeConfig(body, providers);
      const record = await saveConfig(config);
      const token = await encodeConfigToken(record.id);

      sendJson(response, 200, {
        token,
        configId: record.id,
        manifestUrl: `${baseUrl}/u/${token}/manifest.json`
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
        mediaId
      });
      sendJson(response, 200, { streams: result.streams });
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
    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Panda listening on http://${HOST}:${PORT}`);
});
