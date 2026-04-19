const DEFAULT_TIMEOUT = 10000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ── NZBget (JSON-RPC) ──

async function nzbgetRequest(config, method, params = []) {
  const baseUrl = config.downloadClientUrl.replace(/\/+$/, "");
  const auth = Buffer.from(
    `${config.downloadClientUsername}:${config.downloadClientPassword}`,
  ).toString("base64");

  const response = await fetchWithTimeout(`${baseUrl}/jsonrpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ method, params, id: 1 }),
  });

  if (!response.ok) {
    throw new Error(`NZBget HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "NZBget error");
  }
  return data.result;
}

async function sendNzbToNzbget(config, nzbUrl, title) {
  // NZBget append: (NZBFilename, NZBContent_or_URL, Category, Priority, DupeKey, DupeScore, DupeMode, PPParameters)
  return await nzbgetRequest(config, "append", [
    `${title}.nzb`,
    nzbUrl,
    "",
    0,
    "",
    0,
    "SCORE",
    [],
  ]);
}

// ── SABnzbd (REST) ──

async function sabnzbdRequest(config, params) {
  const baseUrl = config.downloadClientUrl.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/api`);
  url.searchParams.set("apikey", config.downloadClientApiKey);
  url.searchParams.set("output", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    throw new Error(`SABnzbd HTTP ${response.status}`);
  }
  return await response.json();
}

async function sendNzbToSabnzbd(config, nzbUrl, title) {
  return await sabnzbdRequest(config, {
    mode: "addurl",
    name: nzbUrl,
    nzbname: title,
  });
}

// ── Public API ──

export async function sendToDownloadClient(config, nzbUrl, title) {
  if (config.downloadClient === "nzbget") {
    return await sendNzbToNzbget(config, nzbUrl, title);
  }
  if (config.downloadClient === "sabnzbd") {
    return await sendNzbToSabnzbd(config, nzbUrl, title);
  }
  throw new Error(`Unknown download client: ${config.downloadClient}`);
}

export async function testDownloadClient(config) {
  try {
    if (config.downloadClient === "nzbget") {
      const version = await nzbgetRequest(config, "version");
      return { ok: true, version };
    }
    if (config.downloadClient === "sabnzbd") {
      const data = await sabnzbdRequest(config, { mode: "version" });
      return { ok: true, version: data.version };
    }
    return { ok: false, error: "No download client configured" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
