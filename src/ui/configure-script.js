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
  const torveToken = params.get("torve_token");
  const REDACTION_MARKER = "[redacted]";
  const banner = document.getElementById("torve-auth-banner");
  if (banner) banner.style.display = torveToken ? "none" : "";

  const form = document.getElementById("config-form");
  const result = document.getElementById("result");
  const debridAccountList = document.getElementById("debridAccountList");
  const addDebridAccountBtn = document.getElementById("addDebridAccountBtn");
  const debridServiceOptions = JSON.parse(debridAccountList.getAttribute("data-options"));
  let revealSecretsPromise = null;

  function optionTags(values, selected) {
    return values
      .map((value) => '<option value="' + value + '"' + (value === selected ? " selected" : "") + ">" + value + "</option>")
      .join("");
  }

  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function setIfRedacted(input, value) {
    if (!input || !value) return;
    if (input.value === REDACTION_MARKER || input.value === "") {
      input.value = value;
    }
  }

  function hydrateSecretInputs(secrets) {
    const debridByService = new Map((secrets.debrid_accounts || []).map((row) => [row.service, row]));
    Array.from(document.querySelectorAll(".debrid-account-row")).forEach((row) => {
      const service = row.querySelector(".debrid-service")?.value;
      const stored = debridByService.get(service);
      if (!stored) return;
      setIfRedacted(row.querySelector(".debrid-apikey"), stored.api_key);
      setIfRedacted(row.querySelector(".debrid-putio-client-id"), stored.putio_client_id);
    });

    document.querySelectorAll('input[name="usenetPassword"]').forEach((input) => setIfRedacted(input, secrets.usenet_password));
    setIfRedacted(document.querySelector('input[name="downloadClientPassword"]'), secrets.download_client_password);
    setIfRedacted(document.querySelector('input[name="downloadClientApiKey"]'), secrets.download_client_api_key);

    Array.from(document.querySelectorAll(".nzb-indexer-row")).forEach((row, i) => {
      const stored = (secrets.nzb_indexers || [])[i];
      if (stored) setIfRedacted(row.querySelector(".nzb-apikey"), stored.api_key);
    });
  }

  async function revealStoredSecrets() {
    const editConfigId = form.dataset.editConfigId;
    if (!editConfigId || !torveToken) return null;
    if (!revealSecretsPromise) {
      revealSecretsPromise = fetch("/api/v1/configs/me/secrets", {
        method: "GET",
        headers: {
          authorization: "Bearer " + torveToken,
          "x-panda-config-id": editConfigId,
        },
      }).then(async (response) => {
        if (!response.ok) return null;
        return await response.json();
      }).catch(() => null);
    }
    const secrets = await revealSecretsPromise;
    if (secrets) hydrateSecretInputs(secrets);
    return secrets;
  }

  function enhanceSecretInput(input) {
    if (!input || input.dataset.secretEnhanced === "true") return;
    input.dataset.secretEnhanced = "true";
    const wrap = document.createElement("div");
    wrap.className = "secret-input-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secret-toggle";
    button.textContent = "Show";
    button.setAttribute("aria-label", "Show hidden value");
    wrap.appendChild(button);

    button.addEventListener("click", async () => {
      if (input.value === REDACTION_MARKER) {
        await revealStoredSecrets();
      }
      const shouldShow = input.type === "password";
      input.type = shouldShow ? "text" : "password";
      button.textContent = shouldShow ? "Hide" : "Show";
      button.setAttribute("aria-label", shouldShow ? "Hide value" : "Show hidden value");
    });
  }

  function enhanceSecretInputs(root) {
    (root || document).querySelectorAll('input[type="password"]').forEach(enhanceSecretInput);
  }

  function syncDebridRow(row) {
    const service = row.querySelector(".debrid-service")?.value || "none";
    const keyField = row.querySelector(".debrid-key-field");
    const putioField = row.querySelector(".debrid-putio-field");
    if (keyField) keyField.style.display = service !== "none" ? "" : "none";
    if (putioField) putioField.style.display = service === "putio" ? "" : "none";
  }

  function clearDebridRowSecrets(row) {
    const apiKey = row.querySelector(".debrid-apikey");
    const putioClientId = row.querySelector(".debrid-putio-client-id");
    if (apiKey) apiKey.value = "";
    if (putioClientId) putioClientId.value = "";
    row.dataset.credentialCiphertext = "";
    row.dataset.credentialSource = "";
    row.dataset.displayIdentifier = "";
  }

  function debridRowHasSecret(row) {
    return !!(
      row.querySelector(".debrid-apikey")?.value ||
      row.querySelector(".debrid-putio-client-id")?.value ||
      row.dataset.credentialCiphertext
    );
  }

  function hasDebridService(service, exceptRow) {
    return Array.from(debridAccountList.querySelectorAll(".debrid-account-row"))
      .some((row) => row !== exceptRow && row.querySelector(".debrid-service")?.value === service);
  }

  function createDebridRow(account, idx) {
    const service = account?.service || "none";
    const apiKey = account?.apiKey || "";
    const putioClientId = account?.putioClientId || "";
    const html =
      '<div class="debrid-account-row grid" data-idx="' + idx + '" data-credential-ciphertext="' + escapeAttr(account?.credentialCiphertext || "") + '" data-credential-source="' + escapeAttr(account?.credentialSource || "") + '" data-display-identifier="' + escapeAttr(account?.displayIdentifier || "") + '">' +
        '<label class="field"><span>Debrid service</span><select class="debrid-service">' + optionTags(debridServiceOptions, service) + '</select></label>' +
        '<label class="field debrid-key-field" style="' + (service !== "none" ? "" : "display:none") + '"><span>API key or access token</span><input type="password" class="debrid-apikey" value="' + escapeAttr(apiKey) + '" autocomplete="off"></label>' +
        '<label class="field debrid-putio-field" style="' + (service === "putio" ? "" : "display:none") + '"><span>Put.io client ID</span><input type="password" class="debrid-putio-client-id" value="' + escapeAttr(putioClientId) + '" autocomplete="off"></label>' +
        '<button type="button" class="debrid-remove btn-sm">Remove</button>' +
      '</div>';
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.firstElementChild;
  }

  function wireDebridRow(row) {
    const serviceSel = row.querySelector(".debrid-service");
    serviceSel.dataset.previousValue = serviceSel.value;
    serviceSel.addEventListener("change", () => {
      const previousService = serviceSel.dataset.previousValue;
      if (serviceSel.value !== previousService) {
        if (previousService !== "none" && debridRowHasSecret(row) && !hasDebridService(previousService, row)) {
          const preserved = createDebridRow({
            service: previousService,
            apiKey: row.querySelector(".debrid-apikey")?.value || "",
            credentialCiphertext: row.dataset.credentialCiphertext || "",
            credentialSource: row.dataset.credentialSource || "",
            displayIdentifier: row.dataset.displayIdentifier || "",
            putioClientId: row.querySelector(".debrid-putio-client-id")?.value || "",
          }, debridAccountList.children.length);
          debridAccountList.insertBefore(preserved, row);
          wireDebridRow(preserved);
        }
        clearDebridRowSecrets(row);
      }
      serviceSel.dataset.previousValue = serviceSel.value;
      syncDebridRow(row);
    });
    row.querySelector(".debrid-remove").addEventListener("click", () => {
      if (debridAccountList.children.length > 1) {
        row.remove();
        return;
      }
      serviceSel.value = "none";
      clearDebridRowSecrets(row);
      serviceSel.dataset.previousValue = "none";
      syncDebridRow(row);
    });
    syncDebridRow(row);
    enhanceSecretInputs(row);
  }
  Array.from(debridAccountList.querySelectorAll(".debrid-account-row")).forEach(wireDebridRow);
  addDebridAccountBtn.addEventListener("click", () => {
    const newRow = createDebridRow({ service: "none" }, debridAccountList.children.length);
    debridAccountList.appendChild(newRow);
    wireDebridRow(newRow);
  });

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
    enhanceSecretInputs(row);
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
  enhanceSecretInputs(document);

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

  function collectDebridAccounts() {
    const seen = new Set();
    return Array.from(document.querySelectorAll(".debrid-account-row"))
      .map((row) => {
        const service = row.querySelector(".debrid-service")?.value || "none";
        const apiKey = row.querySelector(".debrid-apikey")?.value || "";
        const putioClientId = row.querySelector(".debrid-putio-client-id")?.value || "";
        const keepsStoredSecret = apiKey === REDACTION_MARKER;
        return {
          service,
          apiKey,
          credentialCiphertext: keepsStoredSecret ? (row.dataset.credentialCiphertext || "") : "",
          credentialSource: keepsStoredSecret ? (row.dataset.credentialSource || "") : "",
          displayIdentifier: keepsStoredSecret ? (row.dataset.displayIdentifier || "") : "",
          putioClientId,
        };
      })
      .filter((account) => {
        if (!account.service || account.service === "none") return false;
        if (seen.has(account.service)) return false;
        if (!account.apiKey && !account.credentialCiphertext) return false;
        seen.add(account.service);
        return true;
      });
  }

  // ── Submit ───────────────────────────────────────────────────────
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const debridAccounts = collectDebridAccounts();
    const firstDebridAccount = debridAccounts[0] || {};
    const payload = {
      version: 2,
      qualityProfile: formData.get("qualityProfile"),
      maxQuality: formData.get("maxQuality"),
      releaseLanguage: formData.getAll("releaseLanguages")[0] || "any",
      releaseLanguages: (() => {
        const picked = formData.getAll("releaseLanguages");
        return picked.length === 0 ? ["any"] : picked;
      })(),
      debridService: firstDebridAccount.service || "none",
      debridApiKey: firstDebridAccount.apiKey || "",
      debridCredentialCiphertext: firstDebridAccount.credentialCiphertext || "",
      debridCredentialSource: firstDebridAccount.credentialSource || "",
      debridDisplayIdentifier: firstDebridAccount.displayIdentifier || "",
      putioClientId: firstDebridAccount.putioClientId || "",
      debridAccounts,
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
    if (torveToken) headers.authorization = "Bearer " + torveToken;

    // Two paths:
    //   - Edit mode: form was rendered with data-edit-config-id (server
    //     looked up the user's existing config and pre-filled the form).
    //     Submit PATCHes /api/v1/configs/me — keeps the same manifest URL,
    //     just updates settings in place.
    //   - Create mode: form has no edit-config-id. Submit POSTs
    //     /api/configs to mint a new config + manifest.
    const editConfigId = form.dataset.editConfigId;
    let response;
    if (editConfigId) {
      response = await fetch("/api/v1/configs/me", {
        method: "PATCH",
        headers: { ...headers, "x-panda-config-id": editConfigId },
        body: JSON.stringify(payload),
      });
    } else {
      response = await fetch("/api/configs", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      });
    }
    const data = await response.json();

    if (!response.ok) {
      result.hidden = false;
      result.innerHTML = "<h3>Could not save Panda config</h3><p>" + (data.error || data.message || "Unknown error") + "</p>";
      return;
    }

    if (editConfigId) {
      // Update — no fresh manifest URL, just confirm.
      result.hidden = false;
      result.innerHTML =
        "<h3 style='color:#4ade80'>✓ Panda config updated</h3>" +
        "<p>Your settings are saved. Every signed-in device picks up the change on its next stream request — no app restart needed.</p>" +
        "<p class='note' style='margin-top:8px'>Manifest URL is unchanged.</p>";
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
