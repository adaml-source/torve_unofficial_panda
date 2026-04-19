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
  resultLimits
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Panda Configure</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1115;
        --panel: rgba(19, 28, 35, 0.9);
        --line: rgba(255, 255, 255, 0.12);
        --text: #edf4f8;
        --muted: #99a9b5;
        --accent: #ffb84d;
        --accent-2: #ff8f1f;
        --accent-ink: #211200;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "Helvetica Neue", sans-serif;
        background:
          radial-gradient(circle at top right, rgba(255, 184, 77, 0.16), transparent 28%),
          radial-gradient(circle at top left, rgba(90, 200, 130, 0.12), transparent 24%),
          linear-gradient(180deg, #081015 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 28px 18px 52px;
      }
      h1, h2, h3, p { margin-top: 0; }
      h1 {
        font-size: clamp(34px, 5vw, 52px);
        letter-spacing: -0.04em;
        margin-bottom: 10px;
      }
      p, li { color: var(--muted); line-height: 1.5; }
      .hero {
        border: 1px solid var(--line);
        border-radius: 28px;
        background: linear-gradient(180deg, rgba(17, 26, 34, 0.94), rgba(11, 18, 24, 0.96));
        padding: 26px;
        box-shadow: 0 16px 60px rgba(0, 0, 0, 0.22);
      }
      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.3fr) minmax(300px, 0.9fr);
        gap: 20px;
      }
      .stat-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .stat {
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
        padding: 16px;
      }
      .stat strong {
        display: block;
        color: var(--text);
        margin-bottom: 6px;
      }
      .panel {
        margin-top: 18px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        padding: 22px;
      }
      .grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      label.field {
        display: grid;
        gap: 8px;
        font-size: 14px;
      }
      select, input[type="text"], input[type="password"] {
        width: 100%;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(8, 14, 18, 0.95);
        color: var(--text);
        padding: 12px 14px;
      }
      .provider-list {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }
      .provider {
        display: grid;
        grid-template-columns: 20px 1fr auto;
        gap: 12px;
        align-items: start;
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
        background: rgba(255, 255, 255, 0.02);
      }
      .provider-body {
        display: grid;
        gap: 4px;
      }
      .provider small {
        color: var(--muted);
      }
      .tag {
        color: var(--accent);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .inline {
        display: flex;
        gap: 12px 18px;
        flex-wrap: wrap;
      }
      .secret-fields {
        display: grid;
        gap: 12px;
      }
      .result {
        margin-top: 18px;
        padding: 18px;
        border-radius: 18px;
        background: rgba(10, 19, 25, 0.95);
        border: 1px solid rgba(90, 200, 130, 0.25);
      }
      .result[hidden] {
        display: none;
      }
      .result h3 {
        margin-bottom: 8px;
      }
      .result code {
        display: block;
        white-space: pre-wrap;
        word-break: break-all;
        background: rgba(4, 9, 12, 0.92);
        border-radius: 12px;
        padding: 12px;
        margin-top: 10px;
        color: #f6f7f9;
      }
      .button-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      button, a.button-link {
        appearance: none;
        border: none;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        color: var(--accent-ink);
        font-weight: 700;
        border-radius: 999px;
        padding: 13px 18px;
        cursor: pointer;
      }
      .ghost {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--line);
      }
      .note {
        font-size: 13px;
        color: var(--muted);
      }
      @media (max-width: 860px) {
        .hero-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="hero-grid">
          <div>
            <p class="note">Torve addon service</p>
            <h1>Panda</h1>
            <p>
              Panda gives non-power users a guided setup while still exposing the knobs
              advanced users care about. In v1 it stores your debrid credentials server-side
              and proxies Torrentio with a user-specific manifest.
            </p>
          </div>
          <div class="stat-grid">
            <div class="stat">
              <strong>Easy onboarding</strong>
              <span>Recommended providers and sane defaults are preselected.</span>
            </div>
            <div class="stat">
              <strong>Secrets stay server-side</strong>
              <span>Manifest links contain a signed config token, not your debrid API key.</span>
            </div>
            <div class="stat">
              <strong>Torrentio-backed</strong>
              <span>Provider, debrid, and quality filters are translated upstream automatically.</span>
            </div>
            <div class="stat">
              <strong>Torve friendly</strong>
              <span>Use the generated manifest URL in Torve or any compatible Stremio client.</span>
            </div>
          </div>
        </div>
      </section>

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

        <div class="button-row" style="margin-top: 18px;">
          <button type="submit">Generate Panda Manifest</button>
          <a class="button-link ghost" href="${baseUrl}/manifest.json" target="_blank" rel="noreferrer">Open base manifest</a>
        </div>
      </form>

      <section id="result" class="result" hidden></section>
      <p class="note">Base URL: <code>${baseUrl}</code></p>
    </main>

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
          enabledProviders: formData.getAll("enabledProviders")
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
