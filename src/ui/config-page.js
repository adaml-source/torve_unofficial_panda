function optionTags(values, selectedValue) {
  return values
    .map((value) => {
      const selected = value === selectedValue ? " selected" : "";
      return `<option value="${value}"${selected}>${value}</option>`;
    })
    .join("");
}

function providerCards(providers, enabledProviders) {
  const enabled = new Set(enabledProviders);

  return providers
    .map((provider) => {
      const checked = enabled.has(provider.id) ? " checked" : "";

      return `
        <label class="provider">
          <input type="checkbox" name="enabledProviders" value="${provider.id}"${checked}>
          <span class="provider-body">
            <strong>${provider.name}</strong>
            <small>${provider.description}</small>
          </span>
          <span class="tag">${provider.category}</span>
        </label>
      `;
    })
    .join("");
}

export function renderConfigPage({
  baseUrl,
  providers,
  config,
  qualityOptions,
  qualityProfiles,
  debridServices,
  releaseLanguages,
  sortOptions,
  resultLimits,
  usenetProviders = ["none", "easynews", "generic"],
  nzbIndexers = ["none", "nzbgeek", "scenenzbs", "dognzb", "nzbplanet", "custom"],
  downloadClients = ["none", "nzbget", "sabnzbd", "premiumize", "torbox", "alldebrid"]
}) {
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
        /* Torve tokens — mirror of /assets/site-base.css + app.css */
        --t-bg: #08080e;
        --t-bg-elevated: #0e0e16;
        --t-bg-card: #111118;
        --t-bg-input: #16161e;
        --t-border: rgba(255,255,255,.1);
        --t-border-hover: rgba(255,255,255,.12);
        --t-border-focus: rgba(200,164,78,.35);
        --t-text: #e4e4e7;
        --t-text-strong: #ffffff;
        --t-text-muted: #71717a;
        --t-text-subtle: #52525b;
        --t-accent: #c8a44e;
        --t-accent-light: #dbb95c;
        --t-accent-glow: rgba(200,164,78,.15);
        --t-success: #22c55e;
        --t-radius-sm: 8px;
        --t-radius: 10px;
        --t-radius-lg: 16px;
        --t-transition: .2s ease;
        --t-font: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        --t-max-w: 1140px;
        /* App-page aliases */
        --bg: var(--t-bg);
        --bg-card: var(--t-bg-card);
        --bg-input: var(--t-bg-input);
        --border: var(--t-border);
        --text: var(--t-text);
        --text-muted: var(--t-text-muted);
        --accent: var(--t-accent);
        --radius: var(--t-radius);
        --radius-lg: var(--t-radius-lg);
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--t-font);
        background: var(--t-bg);
        color: var(--t-text);
        min-height: 100vh;
        -webkit-font-smoothing: antialiased;
        line-height: 1.6;
      }
      a { color: inherit; text-decoration: none; }

      /* ── Torve site header (mirror) ─────────────────────────────── */
      .site-header {
        position: sticky; top: 0; z-index: 100;
        background: rgba(8,8,14,.85);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border-bottom: 1px solid var(--t-border);
      }
      .site-header-inner {
        max-width: var(--t-max-w);
        margin: 0 auto;
        padding: 0 24px;
        display: flex;
        align-items: center;
        height: 64px;
      }
      .site-header-logo { height: 56px; width: auto; flex-shrink: 0; }
      .site-header-nav {
        display: flex;
        gap: 24px;
        margin-left: 32px;
        font-size: 14px;
        font-weight: 500;
        color: var(--t-text-muted);
      }
      .site-header-nav a { transition: color var(--t-transition); letter-spacing: .01em; }
      .site-header-nav a:hover { color: var(--t-text-strong); }
      .site-header-nav a.active { color: var(--t-accent); }
      .site-header-spacer { flex: 1; }
      .site-header-actions { display: flex; align-items: center; gap: 10px; }
      .t-btn {
        display: inline-flex; align-items: center; justify-content: center;
        font-family: var(--t-font); font-weight: 600;
        border: none; border-radius: var(--t-radius);
        cursor: pointer; text-decoration: none; white-space: nowrap;
        transition: all var(--t-transition);
      }
      .t-btn-secondary {
        padding: 8px 18px; font-size: 13px;
        background: transparent; color: var(--t-text-muted);
        border: 1px solid var(--t-border);
      }
      .t-btn-secondary:hover { color: var(--t-text); border-color: var(--t-border-hover); }

      /* ── Portal page shell (mirror) ──────────────────────────────── */
      .portal-page {
        margin-top: 0;
        min-height: calc(100vh - 64px);
        padding: 0 32px 80px;
      }
      .portal-2col {
        max-width: 1100px; margin: 0 auto;
        display: grid;
        grid-template-columns: 1fr 280px;
        gap: 32px;
        align-items: start;
        padding-top: 20px;
      }
      .portal-primary { min-width: 0; }
      .portal-page-title {
        font-size: 28px; font-weight: 700;
        color: #fff; margin-bottom: 6px;
        letter-spacing: -.02em;
      }
      .portal-page-intro {
        font-size: 15px;
        color: var(--text-muted);
        line-height: 1.6;
        margin-bottom: 32px;
        max-width: 560px;
      }
      .portal-section-header {
        margin: 32px 0 16px;
        padding-top: 12px;
        border-top: 1px solid var(--border);
      }
      .portal-section-header h2 {
        font-size: 17px; font-weight: 700;
        color: var(--t-text-strong); margin-bottom: 4px;
      }
      .portal-section-header span { font-size: 13px; color: var(--text-muted); }

      /* ── Right rail ──────────────────────────────────────────────── */
      .portal-rail { position: sticky; top: 80px; }
      .portal-rail-card {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 20px 22px;
        margin-bottom: 16px;
      }
      .portal-rail-card h3 {
        font-size: 11px; font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: .05em;
        margin-bottom: 14px;
      }
      .portal-rail-nav { list-style: none; padding: 0; margin: 0; }
      .portal-rail-nav li { margin-bottom: 2px; }
      .portal-rail-nav a {
        display: block;
        padding: 8px 12px;
        font-size: 13px; font-weight: 500;
        color: var(--text-muted);
        border-radius: 6px;
        transition: color .2s, background .2s;
      }
      .portal-rail-nav a:hover { color: var(--text); background: rgba(255,255,255,.03); }

      /* ── Content: hero panel ─────────────────────────────────────── */
      .panda-hero {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 26px 28px;
        margin-bottom: 24px;
      }
      .panda-hero .tagline {
        font-size: 12px; color: var(--accent);
        letter-spacing: .05em; text-transform: uppercase;
        font-weight: 600; margin-bottom: 8px;
      }
      .panda-hero h1 {
        font-size: 32px; font-weight: 700;
        color: var(--t-text-strong);
        letter-spacing: -.02em;
        margin-bottom: 10px;
      }
      .panda-hero p {
        font-size: 14px; color: var(--text-muted);
        line-height: 1.65;
        max-width: 640px;
      }
      .panda-hero-stats {
        margin-top: 20px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .panda-hero-stat {
        background: var(--t-bg-elevated);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 12px 14px;
      }
      .panda-hero-stat strong {
        display: block; font-size: 12.5px; font-weight: 600;
        color: var(--t-text-strong); margin-bottom: 2px;
      }
      .panda-hero-stat span { font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }

      /* ── Panels ──────────────────────────────────────────────────── */
      .panel {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 22px 24px;
        margin-top: 16px;
      }
      .panel > h2 {
        font-size: 16px; font-weight: 600;
        color: var(--t-text-strong);
        margin-bottom: 6px;
      }
      .panel > p {
        font-size: 13px; color: var(--text-muted);
        margin-bottom: 18px; line-height: 1.5;
      }

      /* ── Form elements ───────────────────────────────────────────── */
      .grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      label.field {
        display: grid;
        gap: 6px;
        font-size: 12.5px;
        color: var(--text);
        font-weight: 500;
      }
      select, input[type="text"], input[type="password"], input[type="number"] {
        width: 100%;
        border-radius: var(--t-radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-input);
        color: var(--text);
        padding: 10px 12px;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color .2s;
      }
      select:focus, input:focus { border-color: var(--t-border-focus); }
      select::placeholder, input::placeholder { color: var(--t-text-subtle); }

      .provider-list {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }
      .provider {
        display: grid;
        grid-template-columns: 20px 1fr auto;
        gap: 12px;
        align-items: start;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 12px 14px;
        background: var(--t-bg-elevated);
        cursor: pointer;
        transition: border-color .2s;
      }
      .provider:hover { border-color: var(--t-border-hover); }
      .provider-body { display: grid; gap: 4px; }
      .provider strong { color: var(--t-text-strong); font-size: 13px; font-weight: 600; }
      .provider small { color: var(--text-muted); font-size: 11.5px; line-height: 1.5; }
      .tag {
        color: var(--accent);
        font-size: 10px; font-weight: 700;
        text-transform: uppercase; letter-spacing: .04em;
        padding: 2px 7px; border-radius: 4px;
        background: var(--t-accent-glow);
        align-self: start;
      }

      .inline { display: flex; gap: 12px 18px; flex-wrap: wrap; }
      .secret-fields { display: grid; gap: 12px; }

      .result {
        margin-top: 18px;
        padding: 20px 22px;
        border-radius: var(--radius-lg);
        background: var(--bg-card);
        border: 1px solid rgba(34,197,94,.2);
      }
      .result[hidden] { display: none; }
      .result h3 {
        color: var(--t-success); font-size: 14px;
        font-weight: 600; margin-bottom: 8px;
      }
      .result code {
        display: block;
        white-space: pre-wrap; word-break: break-all;
        background: var(--t-bg);
        border: 1px solid var(--border);
        border-radius: var(--t-radius-sm);
        padding: 12px 14px; margin-top: 10px;
        color: var(--text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }

      .button-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
      button, a.button-link {
        appearance: none; text-decoration: none;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--accent);
        color: #08080e;
        font-weight: 600; font-size: 13px;
        border: 1px solid var(--accent);
        border-radius: var(--t-radius-sm);
        padding: 10px 20px;
        cursor: pointer;
        font-family: inherit;
        transition: opacity .2s;
      }
      button:hover, a.button-link:hover { opacity: .88; }
      .ghost {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
      }
      .ghost:hover { background: var(--t-bg-elevated); border-color: var(--t-border-hover); opacity: 1; }

      .note { font-size: 12px; color: var(--text-muted); }
      .help { font-size: 12px; color: var(--text-muted); line-height: 1.5; font-weight: 400; }

      /* Info panels (field guidance) */
      .info-panel {
        margin-top: 18px;
        padding: 14px 16px;
        background: var(--t-accent-glow);
        border: 1px solid rgba(200,164,78,.2);
        border-radius: var(--radius);
      }
      .info-panel h3 {
        color: var(--accent); font-size: 12.5px;
        font-weight: 600; margin-bottom: 6px;
      }
      .info-panel p, .info-panel li {
        font-size: 12px; line-height: 1.6;
        color: var(--text-muted); margin-bottom: 4px;
      }
      .info-panel ul { padding-left: 18px; margin: 6px 0 0; }
      .info-panel strong { color: var(--text); }
      .info-panel a { color: var(--accent); text-decoration: underline; }

      @media (max-width: 900px) {
        .portal-2col { grid-template-columns: 1fr; }
        .portal-rail { position: static; }
      }
      @media (max-width: 640px) {
        .site-header-inner { padding: 0 16px; }
        .site-header-nav { display: none; }
        .portal-page { padding: 0 16px 60px; }
      }
    </style>
  </head>
  <body>
    <!-- Shared Torve site header -->
    <header class="site-header">
      <div class="site-header-inner">
        <a href="https://torve.app"><img src="https://torve.app/assets/torve-logo-transparent.png" alt="Torve" class="site-header-logo"></a>
        <nav class="site-header-nav">
          <a href="https://torve.app/app/">Overview</a>
          <a href="https://torve.app/app/setup.html">Setup</a>
          <a href="https://torve.app/app/extensions.html" class="active">Extensions</a>
          <a href="https://torve.app/app/devices.html">Devices</a>
          <a href="https://torve.app/app/help.html">Help</a>
          <a href="https://torve.app/app/premium.html">Premium</a>
          <a href="https://torve.app/app/account.html">Account</a>
        </nav>
        <div class="site-header-spacer"></div>
        <div class="site-header-actions">
          <a href="https://torve.app/app/extensions.html" class="t-btn t-btn-secondary">← Back to Torve</a>
        </div>
      </div>
    </header>
    <div class="portal-page">
      <div class="portal-2col">
        <div class="portal-primary">
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
            <img src="/logo.png" alt="Panda" style="width:56px;height:56px;border-radius:12px;flex-shrink:0">
            <h1 class="portal-page-title" style="margin-bottom:0">Panda setup</h1>
          </div>
          <p class="portal-page-intro">
            Configure your streaming sources — debrid, Usenet, and provider filters — in one place.
            Panda stores credentials server-side and gives you back a single manifest URL to install in Torve.
          </p>

          <!-- Field guidance panel -->
          <div class="info-panel">
            <h3>What goes where</h3>
            <ul>
              <li><strong>Debrid API key</strong> — from your debrid provider (e.g. <a href="https://real-debrid.com/apitoken" target="_blank" rel="noopener">real-debrid.com/apitoken</a>, <a href="https://alldebrid.com/apikeys/" target="_blank" rel="noopener">alldebrid.com/apikeys</a>)</li>
              <li><strong>Easynews username / password</strong> — your regular Easynews members login</li>
              <li><strong>NZB indexer API key</strong> — from your indexer account settings (NZBgeek, SceneNZBs, DogNZB, NZBPlanet)</li>
              <li><strong>Download client URL</strong> — optional, only if you self-host NZBget or SABnzbd (e.g. <code style="background:rgba(0,0,0,.3);padding:1px 6px;border-radius:4px;font-size:11px">http://10.0.0.5:6789</code>)</li>
            </ul>
          </div>

          <form id="config-form" class="panel">
        <h2>Recommended Setup</h2>
        <p>These defaults are meant to work out of the box. You can still override the advanced filters below.</p>

        <div class="grid">
          <label class="field">
            <span>Debrid service</span>
            <select name="debridService">${optionTags(debridServices, config.debridService)}</select>
          </label>
          <label class="field">
            <span>Quality profile</span>
            <select name="qualityProfile">${optionTags(qualityProfiles, config.qualityProfile)}</select>
          </label>
          <label class="field">
            <span>Maximum quality</span>
            <select name="maxQuality">${optionTags(qualityOptions, config.maxQuality)}</select>
          </label>
          <label class="field">
            <span>Preferred release language</span>
            <select name="releaseLanguage">${optionTags(releaseLanguages, config.releaseLanguage)}</select>
          </label>
        </div>

        <div class="panel">
          <h3>Debrid Credentials</h3>
          <p class="note">Required for debrid-backed streaming. Panda stores these server-side and never puts them in the addon URL.</p>
          <div class="secret-fields">
            <label class="field">
              <span>Debrid API key or access token</span>
              <input type="password" name="debridApiKey" value="${config.debridApiKey || ""}" autocomplete="off">
            </label>
            <label class="field" id="putio-client-field" hidden>
              <span>Put.io client ID</span>
              <input type="text" name="putioClientId" value="${config.putioClientId || ""}" autocomplete="off">
            </label>
          </div>
        </div>

        <div class="panel">
          <h3>Sources</h3>
          <p class="note">The defaults cover the broadest mainstream use cases. Add anime or regional sources only if you need them.</p>
          <div class="provider-list">
            ${providerCards(providers, config.enabledProviders)}
          </div>
        </div>

        <div class="panel">
          <h3>Advanced Filters</h3>
          <div class="inline">
            <label><input type="checkbox" name="groupByQuality"${config.groupByQuality ? " checked" : ""}> Group by quality</label>
            <label><input type="checkbox" name="allowUncached"${config.allowUncached ? " checked" : ""}> Allow uncached results</label>
            <label><input type="checkbox" name="hideDownloadLinks"${config.hideDownloadLinks ? " checked" : ""}> Hide download links</label>
            <label><input type="checkbox" name="hideCatalog"${config.hideCatalog ? " checked" : ""}> Hide addon catalogs</label>
          </div>
          <div class="grid" style="margin-top: 14px;">
            <label class="field">
              <span>Sort torrents by</span>
              <select name="sortTorrentsBy">${optionTags(sortOptions, config.sortTorrentsBy)}</select>
            </label>
            <label class="field">
              <span>Result limit</span>
              <select name="maxResults">${optionTags(resultLimits, config.maxResults)}</select>
            </label>
          </div>
        </div>

        <!-- Usenet -->
        <div class="panel" style="margin-top:16px">
          <h3 style="font-size:15px;margin-bottom:6px">Usenet (optional)</h3>
          <p class="note" style="margin-bottom:14px">Add Usenet as an additional streaming source. Results merge with Torrentio. You can enable a Usenet provider (Easynews), an NZB indexer, or both.</p>

          <label class="field" style="margin-bottom:14px">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);cursor:pointer">
              <input type="checkbox" name="enableUsenet" id="enableUsenet"${config.enableUsenet ? " checked" : ""}>
              <span>Enable Usenet sources</span>
            </label>
          </label>

          <div id="usenet-fields" style="${config.enableUsenet ? "" : "display:none"}">
            <!-- Usenet provider (Easynews / generic NNTP) -->
            <div class="grid" style="margin-bottom:14px">
              <label class="field">
                <span>Usenet provider</span>
                <select name="usenetProvider" id="usenetProvider">${optionTags(usenetProviders, config.usenetProvider)}</select>
              </label>
            </div>

            <div id="usenet-easynews" style="${config.usenetProvider === "easynews" ? "" : "display:none"}">
              <p class="help" style="margin-bottom:10px"><strong style="color:var(--text)">Easynews</strong> — HTTP-based usenet search. Use your regular Easynews members login.</p>
              <div class="grid">
                <label class="field">
                  <span>Easynews username</span>
                  <input type="text" name="usenetUsername" value="${config.usenetUsername || ""}" placeholder="your-easynews-username" autocomplete="off">
                </label>
                <label class="field">
                  <span>Easynews password</span>
                  <input type="password" name="usenetPassword" value="${config.usenetPassword || ""}" placeholder="••••••••" autocomplete="off">
                </label>
              </div>
            </div>

            <div id="usenet-generic" style="${config.usenetProvider === "generic" ? "" : "display:none"}">
              <p class="help" style="margin-bottom:10px"><strong style="color:var(--text)">Generic NNTP</strong> — direct server connection. Credentials are your usenet provider's NNTP login.</p>
              <div class="grid">
                <label class="field">
                  <span>Host</span>
                  <input type="text" name="usenetHost" value="${config.usenetHost || ""}" placeholder="news.example.com" autocomplete="off">
                </label>
                <label class="field">
                  <span>Port</span>
                  <input type="number" name="usenetPort" value="${config.usenetPort || 563}" min="1" max="65535">
                </label>
                <label class="field">
                  <span>Username</span>
                  <input type="text" name="usenetUsername" value="${config.usenetUsername || ""}" autocomplete="off">
                </label>
                <label class="field">
                  <span>Password</span>
                  <input type="password" name="usenetPassword" value="${config.usenetPassword || ""}" autocomplete="off">
                </label>
                <label class="field">
                  <span>Connections</span>
                  <input type="number" name="usenetConnections" value="${config.usenetConnections || 10}" min="1" max="50">
                </label>
                <label class="field" style="align-self:end">
                  <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);cursor:pointer">
                    <input type="checkbox" name="usenetSSL"${config.usenetSSL !== false ? " checked" : ""}>
                    <span>Use SSL</span>
                  </label>
                </label>
              </div>
            </div>

            <!-- NZB indexer -->
            <h3 style="font-size:13px;margin-top:20px;margin-bottom:8px">NZB indexer (optional)</h3>
            <p class="help" style="margin-bottom:10px">Add a Newznab-compatible indexer to find NZB releases. Your app or download client handles the download itself.</p>
            <div class="grid">
              <label class="field">
                <span>Indexer</span>
                <select name="nzbIndexer" id="nzbIndexer">${optionTags(nzbIndexers, config.nzbIndexer)}</select>
              </label>
              <label class="field" id="nzbIndexerUrl-field" style="${config.nzbIndexer === "custom" ? "" : "display:none"}">
                <span>Indexer URL (custom)</span>
                <input type="text" name="nzbIndexerUrl" value="${config.nzbIndexerUrl || ""}" placeholder="https://your-indexer.example/api" autocomplete="off">
              </label>
              <label class="field" id="nzbIndexerApiKey-field" style="${(config.nzbIndexer && config.nzbIndexer !== "none") ? "" : "display:none"}">
                <span>Indexer API key</span>
                <input type="password" name="nzbIndexerApiKey" value="${config.nzbIndexerApiKey || ""}" placeholder="••••••••" autocomplete="off">
              </label>
            </div>

            <!-- Download client -->
            <h3 style="font-size:13px;margin-top:20px;margin-bottom:8px">Download client (optional)</h3>
            <p class="help" style="margin-bottom:10px">
              Local clients (NZBget / SABnzbd) write files to a machine you control.<br>
              Cloud clients (Premiumize / TorBox / AllDebrid) download on the provider's servers and give Panda a streaming URL — no local storage required.
            </p>
            <div class="grid">
              <label class="field">
                <span>Client</span>
                <select name="downloadClient" id="downloadClient">${optionTags(downloadClients, config.downloadClient)}</select>
              </label>
              <label class="field" id="downloadClientUrl-field" style="${(config.downloadClient === "nzbget" || config.downloadClient === "sabnzbd") ? "" : "display:none"}">
                <span>Client URL</span>
                <input type="text" name="downloadClientUrl" value="${config.downloadClientUrl || ""}" placeholder="http://10.0.0.5:6789" autocomplete="off">
              </label>
              <label class="field" id="downloadClientAuth-field" style="${config.downloadClient === "nzbget" ? "" : "display:none"}">
                <span>Username (optional)</span>
                <input type="text" name="downloadClientUsername" value="${config.downloadClientUsername || ""}" autocomplete="off">
              </label>
              <label class="field" id="downloadClientAuthPw-field" style="${config.downloadClient === "nzbget" ? "" : "display:none"}">
                <span>Password</span>
                <input type="password" name="downloadClientPassword" value="${config.downloadClientPassword || ""}" autocomplete="off">
              </label>
              <label class="field" id="downloadClientApiKey-field" style="${(config.downloadClient === "sabnzbd" || config.downloadClient === "premiumize" || config.downloadClient === "torbox" || config.downloadClient === "alldebrid") ? "" : "display:none"}">
                <span>API key</span>
                <input type="password" name="downloadClientApiKey" value="${config.downloadClientApiKey || ""}" autocomplete="off">
              </label>
            </div>
          </div>
        </div>

        <div class="button-row" style="margin-top: 18px;">
          <button type="submit">Generate Panda Manifest</button>
          <a class="button-link ghost" href="${baseUrl}/manifest.json" target="_blank" rel="noreferrer">Open base manifest</a>
        </div>
          </form>

          <section id="result" class="result" hidden></section>
          <p class="note" style="margin-top:16px">Base URL: <code style="background:var(--bg);border:1px solid var(--border);padding:2px 6px;border-radius:4px;font-size:11.5px">${baseUrl}</code></p>
        </div>

        <!-- Right rail -->
        <aside class="portal-rail">
          <div class="portal-rail-card">
            <h3>Quick links</h3>
            <ul class="portal-rail-nav">
              <li><a href="https://torve.app/app/extensions.html">← Back to Torve Extensions</a></li>
              <li><a href="${baseUrl}/manifest.json" target="_blank" rel="noopener">Base manifest</a></li>
              <li><a href="${baseUrl}/healthz" target="_blank" rel="noopener">Service health</a></li>
            </ul>
          </div>
          <div class="portal-rail-card">
            <h3>About Panda</h3>
            <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin:0">
              Panda stores your debrid and Usenet credentials server-side and returns a
              user-specific manifest URL. Your secrets never appear in the addon URL.
            </p>
          </div>
        </aside>
      </div>
    </div>

    <script>
      const form = document.getElementById("config-form");
      const result = document.getElementById("result");
      const debridServiceSelect = form.querySelector('select[name="debridService"]');
      const putioClientField = document.getElementById("putio-client-field");

      function syncDebridFields() {
        putioClientField.hidden = debridServiceSelect.value !== "putio";
      }

      debridServiceSelect.addEventListener("change", syncDebridFields);
      syncDebridFields();

      // ── Usenet field toggles ───────────────────────────────────────
      const enableUsenet = document.getElementById("enableUsenet");
      const usenetFields = document.getElementById("usenet-fields");
      const usenetProviderSel = document.getElementById("usenetProvider");
      const usenetEasynews = document.getElementById("usenet-easynews");
      const usenetGeneric = document.getElementById("usenet-generic");
      const nzbIndexerSel = document.getElementById("nzbIndexer");
      const nzbIndexerUrlField = document.getElementById("nzbIndexerUrl-field");
      const nzbIndexerApiKeyField = document.getElementById("nzbIndexerApiKey-field");
      const downloadClientSel = document.getElementById("downloadClient");
      const dlUrlField = document.getElementById("downloadClientUrl-field");
      const dlAuthField = document.getElementById("downloadClientAuth-field");
      const dlAuthPwField = document.getElementById("downloadClientAuthPw-field");
      const dlApiKeyField = document.getElementById("downloadClientApiKey-field");

      function syncUsenet() {
        usenetFields.style.display = enableUsenet.checked ? "" : "none";
        usenetEasynews.style.display = usenetProviderSel.value === "easynews" ? "" : "none";
        usenetGeneric.style.display = usenetProviderSel.value === "generic" ? "" : "none";

        const nzb = nzbIndexerSel.value;
        const nzbEnabled = nzb && nzb !== "none";
        nzbIndexerUrlField.style.display = nzb === "custom" ? "" : "none";
        nzbIndexerApiKeyField.style.display = nzbEnabled ? "" : "none";

        const dl = downloadClientSel.value;
        const isLocal = dl === "nzbget" || dl === "sabnzbd";
        const isCloud = dl === "premiumize" || dl === "torbox" || dl === "alldebrid";
        // Local (self-hosted) clients need a URL. Only NZBget has a Username +
        // Password field. Both SABnzbd and cloud clients use an API key.
        dlUrlField.style.display = isLocal ? "" : "none";
        dlAuthField.style.display = dl === "nzbget" ? "" : "none";
        dlAuthPwField.style.display = dl === "nzbget" ? "" : "none";
        dlApiKeyField.style.display = (dl === "sabnzbd" || isCloud) ? "" : "none";
      }

      enableUsenet.addEventListener("change", syncUsenet);
      usenetProviderSel.addEventListener("change", syncUsenet);
      nzbIndexerSel.addEventListener("change", syncUsenet);
      downloadClientSel.addEventListener("change", syncUsenet);
      syncUsenet();

      form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const formData = new FormData(form);
        const payload = {
          version: 2,
          qualityProfile: formData.get("qualityProfile"),
          maxQuality: formData.get("maxQuality"),
          releaseLanguage: formData.get("releaseLanguage"),
          debridService: formData.get("debridService"),
          debridApiKey: formData.get("debridApiKey"),
          putioClientId: formData.get("putioClientId"),
          sortTorrentsBy: formData.get("sortTorrentsBy"),
          maxResults: formData.get("maxResults"),
          groupByQuality: formData.get("groupByQuality") === "on",
          allowUncached: formData.get("allowUncached") === "on",
          hideDownloadLinks: formData.get("hideDownloadLinks") === "on",
          hideCatalog: formData.get("hideCatalog") === "on",
          enabledProviders: formData.getAll("enabledProviders"),
          // Usenet
          enableUsenet: formData.get("enableUsenet") === "on",
          usenetProvider: formData.get("usenetProvider") || "none",
          usenetHost: formData.get("usenetHost") || "",
          usenetPort: Number(formData.get("usenetPort")) || 563,
          usenetUsername: formData.get("usenetUsername") || "",
          usenetPassword: formData.get("usenetPassword") || "",
          usenetSSL: formData.get("usenetSSL") === "on",
          usenetConnections: Number(formData.get("usenetConnections")) || 10,
          nzbIndexer: formData.get("nzbIndexer") || "none",
          nzbIndexerUrl: formData.get("nzbIndexerUrl") || "",
          nzbIndexerApiKey: formData.get("nzbIndexerApiKey") || "",
          downloadClient: formData.get("downloadClient") || "none",
          downloadClientUrl: formData.get("downloadClientUrl") || "",
          downloadClientUsername: formData.get("downloadClientUsername") || "",
          downloadClientPassword: formData.get("downloadClientPassword") || "",
          downloadClientApiKey: formData.get("downloadClientApiKey") || ""
        };

        const response = await fetch("/api/configs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();

        if (!response.ok) {
          result.hidden = false;
          result.innerHTML = "<h3>Could not create Panda config</h3><p>" + (data.error || "Unknown error") + "</p>";
          return;
        }

        result.hidden = false;
        result.innerHTML = [
          "<h3>Panda is ready</h3>",
          "<p>Use this manifest URL in Torve or any compatible client.</p>",
          "<code>" + data.manifestUrl + "</code>",
          "<div class='button-row' style='margin-top: 12px;'>",
          "<button type='button' id='copy-manifest'>Copy manifest URL</button>",
          "<a class='button-link ghost' href='" + data.manifestUrl + "' target='_blank' rel='noreferrer'>Open manifest</a>",
          "</div>",
          "<p class='note'>Signed token: " + data.token + "</p>"
        ].join("");

        document.getElementById("copy-manifest").addEventListener("click", async () => {
          await navigator.clipboard.writeText(data.manifestUrl);
        });
      });
    </script>
  </body>
</html>`;
}
