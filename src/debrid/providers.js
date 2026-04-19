/**
 * Debrid provider metadata.
 *
 * Each provider declares:
 * - id, name: stable identifiers
 * - authMethods: array of "oauth" | "apikey"
 * - oauth: endpoint URLs and client ID for device flow (null if unsupported)
 * - logoUrl, helpUrl: for client UI
 *
 * Device-flow client IDs are public values — not secrets.
 */

// Real-Debrid device-code OAuth — public client ID documented in RD API docs.
const REAL_DEBRID = {
  id: "realdebrid",
  name: "Real-Debrid",
  authMethods: ["oauth", "apikey"],
  oauth: {
    clientId: "X245A4XAIBGVM",  // RD open source / device flow client
    deviceCodeUrl: "https://api.real-debrid.com/oauth/v2/device/code",
    credentialsUrl: "https://api.real-debrid.com/oauth/v2/device/credentials",
    tokenUrl: "https://api.real-debrid.com/oauth/v2/token",
    scope: "",
    pollStyle: "rd"  // two-phase: poll credentials then token
  },
  apikeyValidateUrl: "https://api.real-debrid.com/rest/1.0/user",
  logoUrl: "https://fcdn.real-debrid.com/0830/images/logo.svg",
  helpUrl: "https://real-debrid.com/apitoken"
};

// Premiumize OAuth — uses standard device-code flow.
const PREMIUMIZE = {
  id: "premiumize",
  name: "Premiumize",
  authMethods: ["oauth", "apikey"],
  oauth: {
    clientId: "291445189",  // Premiumize public device-flow client
    deviceCodeUrl: "https://www.premiumize.me/token",
    tokenUrl: "https://www.premiumize.me/token",
    scope: "",
    pollStyle: "standard"  // standard RFC 8628
  },
  apikeyValidateUrl: "https://www.premiumize.me/api/account/info",
  logoUrl: "https://www.premiumize.me/assets/img/logo_160.png",
  helpUrl: "https://www.premiumize.me/account"
};

// AllDebrid PIN-based auth — issues a 4-char PIN the user enters on the site.
const ALLDEBRID = {
  id: "alldebrid",
  name: "AllDebrid",
  authMethods: ["oauth", "apikey"],
  oauth: {
    agent: "torve-panda",
    pinUrl: "https://api.alldebrid.com/v4/pin/get",
    checkUrl: "https://api.alldebrid.com/v4/pin/check",
    pollStyle: "alldebrid"
  },
  apikeyValidateUrl: "https://api.alldebrid.com/v4/user",
  logoUrl: "https://alldebrid.com/lib/images/logos/alldebrid_white.svg",
  helpUrl: "https://alldebrid.com/apikeys/"
};

// TorBox — API key only.
const TORBOX = {
  id: "torbox",
  name: "TorBox",
  authMethods: ["apikey"],
  oauth: null,
  apikeyValidateUrl: "https://api.torbox.app/v1/api/user/me",
  logoUrl: "https://torbox.app/torbox_logo.png",
  helpUrl: "https://torbox.app/settings"
};

export const DEBRID_PROVIDERS = [REAL_DEBRID, PREMIUMIZE, ALLDEBRID, TORBOX];

const PROVIDER_MAP = Object.fromEntries(DEBRID_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id) {
  return PROVIDER_MAP[id] || null;
}

/**
 * Public-facing provider list for the /api/v1/providers endpoint.
 * Never expose apikeyValidateUrl or oauth internals to clients.
 */
export function publicProviderList() {
  return DEBRID_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    auth_methods: p.authMethods,
    logo_url: p.logoUrl,
    help_url: p.helpUrl
  }));
}
