// Configure-page client script. Served as a separate static asset (not
// inlined) so it loads under the strict CSP `script-src 'self'` that
// applies to panda.torve.app — inline scripts are blocked.
//
// All form-toggle wiring (Usenet, debrid, indexer rows, language picker,
// download-client fields) and the create-config submit handler live here.

(function () {
  // Show the "open from Torve" banner only when the page was reached
  // without a Torve JWT in the URL — i.e. the visitor will land on the
  // anonymous (management-token) flow unless they re-enter via torve.app.
  const params = new URLSearchParams(window.location.search);
  const banner = document.getElementById("torve-auth-banner");
  if (banner) banner.style.display = params.get("torve_token") ? "none" : "";

  const form = document.getElementById("config-form");
  const result = document.getElementById("result");
  const debridServiceSelect = form.querySelector('select[name="debridService"]');
  const putioClientField = document.getElementById("putio-client-field");

  function syncDebridFields() {
    putioClientField.hidden = debridServiceSelect.value !== "putio";
  }
  debridServiceSelect.addEventListener("change", syncDebridFields);
  syncDebridFields();

  // ── Usenet field toggles ─────────────────────────────────────────
  const enableUsenet = document.getElementById("enableUsenet");
  const usenetFields = document.getElementById("usenet-fields");
  const usenetProviderSel = document.getElementById("usenetProvider");
  const usenetEasynews = document.getElementById("usenet-easynews");
  const usenetGeneric = document.getElementById("usenet-generic");
  const nzbIndexerList = document.getElementById("nzbIndexerList");
  const addNzbIndexerBtn = document.getElementById("addNzbIndexerBtn");
  const nzbIndexerOptions = JSON.parse(nzbIndexerList.getAttribute("data-options"));
  const downloadClientSel = document.getElementById("downloadClient");
  const dlUrlField = document.getElementById("downloadClientUrl-field");
  const dlAuthField = document.getElementById("downloadClientAuth-field");
  const dlAuthPwField = document.getElementById("downloadClientAuthPw-field");
  const dlApiKeyField = document.getElementById("downloadClientApiKey-field");

  function syncUsenet() {
    usenetFields.style.display = enableUsenet.checked ? "" : "none";
    usenetEasynews.style.display = usenetProviderSel.value === "easynews" ? "" : "none";
    usenetGeneric.style.display = usenetProviderSel.value === "generic" ? "" : "none";

    const dl = downloadClientSel.value;
    const isLocal = dl === "nzbget" || dl === "sabnzbd";
    const isCloud = dl === "premiumize" || dl === "torbox" || dl === "alldebrid";
    dlUrlField.style.display = isLocal ? "" : "none";
    dlAuthField.style.display = dl === "nzbget" ? "" : "none";
    dlAuthPwField.style.display = dl === "nzbget" ? "" : "none";
    dlApiKeyField.style.display = (dl === "sabnzbd" || isCloud) ? "" : "none";
  }

  function syncIndexerRow(row) {
    const typeSel = row.querySelector(".nzb-type");
    const urlField = row.querySelector(".nzb-url")?.parentElement;
    const apiKeyField = row.querySelector(".nzb-apikey")?.parentElement;
    const t = typeSel.value;
    if (urlField) urlField.style.display = t === "custom" ? "" : "none";
    if (apiKeyField) apiKeyField.style.display = (t && t !== "none") ? "" : "none";
  }
  function wireIndexerRow(row) {
    row.querySelector(".nzb-type").addEventListener("change", () => syncIndexerRow(row));
    row.querySelector(".nzb-remove").addEventListener("click", () => {
      if (nzbIndexerList.children.length > 1) row.remove();
      else {
        row.querySelector(".nzb-type").value = "none";
        row.querySelector(".nzb-apikey").value = "";
        if (row.querySelector(".nzb-url")) row.querySelector(".nzb-url").value = "";
        syncIndexerRow(row);
      }
    });
    syncIndexerRow(row);
  }
  Array.from(nzbIndexerList.querySelectorAll(".nzb-indexer-row")).forEach(wireIndexerRow);
  addNzbIndexerBtn.addEventListener("click", () => {
    const idx = nzbIndexerList.children.length;
    const typeOpts = nzbIndexerOptions
      .map((o) => '<option value="' + o + '">' + o + '</option>')
      .join("");
    const html =
      '<div class="nzb-indexer-row grid" data-idx="' + idx + '" style="position:relative;padding:10px;background:var(--bg-input,#12121a);border:1px solid var(--border,#27272a);border-radius:8px;margin-bottom:8px">' +
        '<label class="field"><span>Indexer</span><select class="nzb-type">' + typeOpts + '</select></label>' +
        '<label class="field" style="display:none"><span>URL (custom)</span><input type="text" class="nzb-url" placeholder="https://your-indexer.example/api" autocomplete="off"></label>' +
        '<label class="field" style="display:none"><span>API key</span><input type="password" class="nzb-apikey" placeholder="••••••••" autocomplete="off"></label>' +
        '<button type="button" class="nzb-remove btn-sm" style="position:absolute;top:8px;right:8px;padding:4px 8px;font-size:11px;background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;cursor:pointer">Remove</button>' +
      '</div>';
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const newRow = tmp.firstElementChild;
    nzbIndexerList.appendChild(newRow);
    wireIndexerRow(newRow);
  });

  enableUsenet.addEventListener("change", syncUsenet);
  usenetProviderSel.addEventListener("change", syncUsenet);
  downloadClientSel.addEventListener("change", syncUsenet);
  syncUsenet();

  // ── Language multi-select: "any" toggle exclusivity ──────────────
  const langBoxes = Array.from(document.querySelectorAll('input[name="releaseLanguages"]'));
  function syncLangSelection(clicked) {
    if (!clicked) return;
    if (clicked.value === "any" && clicked.checked) {
      langBoxes.forEach((cb) => { if (cb.value !== "any") cb.checked = false; });
    } else if (clicked.value !== "any" && clicked.checked) {
      const anyBox = langBoxes.find((cb) => cb.value === "any");
      if (anyBox) anyBox.checked = false;
    }
  }
  langBoxes.forEach((cb) => cb.addEventListener("change", () => syncLangSelection(cb)));

  // ── Submit ───────────────────────────────────────────────────────
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const payload = {
      version: 2,
      qualityProfile: formData.get("qualityProfile"),
      maxQuality: formData.get("maxQuality"),
      releaseLanguage: formData.getAll("releaseLanguages")[0] || "any",
      releaseLanguages: (() => {
        const picked = formData.getAll("releaseLanguages");
        return picked.length === 0 ? ["any"] : picked;
      })(),
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
      enableUsenet: formData.get("enableUsenet") === "on",
      usenetProvider: formData.get("usenetProvider") || "none",
      usenetHost: formData.get("usenetHost") || "",
      usenetPort: Number(formData.get("usenetPort")) || 563,
      usenetUsername: formData.get("usenetUsername") || "",
      usenetPassword: formData.get("usenetPassword") || "",
      usenetSSL: formData.get("usenetSSL") === "on",
      usenetConnections: Number(formData.get("usenetConnections")) || 10,
      nzbIndexers: (() => {
        const rows = Array.from(document.querySelectorAll(".nzb-indexer-row"));
        return rows.map((r) => ({
          type: r.querySelector(".nzb-type").value,
          url: r.querySelector(".nzb-url")?.value || "",
          apiKey: r.querySelector(".nzb-apikey")?.value || "",
        })).filter((x) => x.type && x.type !== "none" && x.apiKey);
      })(),
      nzbIndexer: (() => {
        const first = document.querySelector(".nzb-indexer-row");
        return first?.querySelector(".nzb-type")?.value || "none";
      })(),
      nzbIndexerUrl: (() => {
        const first = document.querySelector(".nzb-indexer-row");
        return first?.querySelector(".nzb-url")?.value || "";
      })(),
      nzbIndexerApiKey: (() => {
        const first = document.querySelector(".nzb-indexer-row");
        return first?.querySelector(".nzb-apikey")?.value || "";
      })(),
      easynewsPreferNzb: formData.get("easynewsPreferNzb") === "on",
      downloadClient: formData.get("downloadClient") || "none",
      downloadClientUrl: formData.get("downloadClientUrl") || "",
      downloadClientUsername: formData.get("downloadClientUsername") || "",
      downloadClientPassword: formData.get("downloadClientPassword") || "",
      downloadClientApiKey: formData.get("downloadClientApiKey") || "",
    };

    // Forward Torve account auth if the page was opened with one.
    const headers = { "content-type": "application/json" };
    const torveToken = new URLSearchParams(window.location.search).get("torve_token");
    if (torveToken) headers.authorization = "Bearer " + torveToken;

    const response = await fetch("/api/configs", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      result.hidden = false;
      result.innerHTML = "<h3>Could not create Panda config</h3><p>" + (data.error || "Unknown error") + "</p>";
      return;
    }

    const sections = [
      "<h3>Panda is ready</h3>",
      "<p>Use this manifest URL in Torve or any compatible client.</p>",
      "<code>" + data.manifestUrl + "</code>",
      "<div class='button-row' style='margin-top: 12px;'>",
      "<button type='button' id='copy-manifest'>Copy manifest URL</button>",
      "<a class='button-link ghost' href='" + data.manifestUrl + "' target='_blank' rel='noreferrer'>Open manifest</a>",
      "</div>",
    ];
    if (data.accountManaged) {
      sections.push(
        "<p class='note' style='margin-top:14px;color:#4ade80'>" +
        "✓ Bound to your Torve account. Sign in to Torve on any device to manage this config.</p>"
      );
    } else if (data.managementToken) {
      sections.push(
        "<div style='margin-top:14px;padding:12px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);border-radius:8px'>",
        "<p style='margin:0 0 6px;font-weight:600;color:#fbbf24'>⚠ Management token (shown once)</p>",
        "<code style='word-break:break-all'>" + data.managementToken + "</code>",
        "<p style='margin:6px 0 0;font-size:12px;color:#888'>Save this now. Required to edit or delete this config later.</p>",
        "</div>"
      );
    }
    sections.push("<p class='note' style='margin-top:14px'>Signed token: " + data.token + "</p>");

    result.hidden = false;
    result.innerHTML = sections.join("");

    document.getElementById("copy-manifest").addEventListener("click", async () => {
      await navigator.clipboard.writeText(data.manifestUrl);
    });
  });
})();
