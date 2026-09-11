/* Supabase project config — publishable key, safe for browser use.
   Self-hosted instance: https://supabase.carlocrizaldo.com
   Key is the legacy symmetric (HS256) anon JWT this instance issues; the
   asymmetric key from the same .env is rejected by this deployment. */
const SUPABASE_URL = "https://supabase.carlocrizaldo.com";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4OTc5MTkwLCJleHAiOjE5NDY2NTkxOTB9.kqExn5n-YwwgRfVbCvIUsIMFmQ8fPYx5apkviDgXZtM";

/* The hub owns the only login form. Dashboards send users back here. */
const HUB_URL = "/";   // the hub is the root of this origin

/* Ports used only in the offline cross-origin harness (see below). */
const HARNESS_PORTS = { hub: 8090, aging: 8091, inventory: 8092, purchasing: 8093 };

function isLocalDev() {
  return /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
}

/* Sessions live in localStorage, which is per-ORIGIN. hub.abederp.com and
   aging.abederp.com cannot see each other's session, so in production the hub
   hands the session over in the URL fragment and the dashboard adopts it.

   The cross-origin behaviour is only exercised when four servers are running.
   Add ?crossorigin=1 to the hub URL for that; otherwise local use stays on one
   origin and needs no handoff at all. */
function crossOriginHarness() {
  try {
    return new URLSearchParams(location.search).get('crossorigin') === '1';
  } catch (e) { return false; }
}

/* Absolute origin for a dashboard, or null to use the relative sibling path. */
function resolveSiteOrigin(id) {
  if (!isLocalDev()) return null;              // production: the card's own url
  if (!crossOriginHarness()) return null;      // one local server: same origin
  const port = HARNESS_PORTS[id];
  return port ? 'http://' + location.hostname + ':' + port + '/' : null;
}

/* Where the "go to the hub" links point. The hub passes its own location in the
   hand-off fragment, so a dashboard always knows where to send the user back —
   even in the four-port harness where a relative path would resolve to the wrong
   port. */
function resolveHubUrl() {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    const hub = h.get('hub');
    if (hub) return hub;
  } catch (e) { /* ignore */ }
  if (location.protocol === 'file:') {
    return new URL('../hub/index.html', location.href).href;
  }
  if (!isLocalDev()) return HUB_URL;           // production
  if (crossOriginHarness()) {
    return 'http://' + location.hostname + ':' + HARNESS_PORTS.hub + '/';
  }
  return new URL('../hub/', location.href).href;   // one local server
}
