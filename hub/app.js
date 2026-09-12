/* ERP Dashboards hub — cards, per-user access, and the session handoff.

   The hub is the only place a user signs in. Because localStorage is per-origin,
   a dashboard on another subdomain cannot read this session, so an allowed card
   navigates to the dashboard with the tokens in the URL fragment and the
   dashboard adopts them (see each site's auth.js).

   Fragments are never sent to a server, so the tokens do not leak through
   Referer; the dashboard strips the fragment from the address bar as soon as it
   has adopted the session. */
'use strict';

const HUB_ICONS = {
  box: '<path d="M21 8.5v7a2 2 0 0 1-1 1.73l-6 3.5a2 2 0 0 1-2 0l-6-3.5A2 2 0 0 1 5 15.5v-7a2 2 0 0 1 1-1.73l6-3.5a2 2 0 0 1 2 0l6 3.5a2 2 0 0 1 1 1.73Z"/><path d="m5.3 7.1 6.7 4 6.7-4"/><path d="M12 20.5v-9.4"/>',
  cart: '<circle cx="9" cy="20" r="1"/><circle cx="18.5" cy="20" r="1"/><path d="M2.5 3h2.1l2.3 11a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 7H5.2"/>',
  hourglass: '<path d="M7 3h10"/><path d="M7 21h10"/><path d="M17 3v3.1a5 5 0 0 1-1.6 3.6L12 12.5l-3.4-2.8A5 5 0 0 1 7 6.1V3"/><path d="M7 21v-3.1a5 5 0 0 1 1.6-3.6l3.4-2.8 3.4 2.8a5 5 0 0 1 1.6 3.6V21"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
};

document.addEventListener('auth:ready', ev => {
  const HUB = window.__HUB__ || { dashboards: [], built_at: '' };
  const allowed = new Set((ev.detail && ev.detail.dashboards) || []);
  const grid = document.getElementById('grid');
  const isFile = location.protocol === 'file:';
  const isLocal = typeof isLocalDev === 'function' && isLocalDev();

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const svg = (name, cls) =>
    `<svg class="icon ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${HUB_ICONS[name] || ''}</svg>`;

  /* Where to send an allowed card.

     Everything is served from ONE origin: the hub at "/", each dashboard at
     "/<id>/" (nginx aliases /aging/, /inventory/, /purchasing/ into place). So the
     target is a sibling path on this origin, never an external subdomain — the
     session in localStorage is already visible there and no handoff is needed. */
  function targetFor(d) {
    const localOrigin = typeof resolveSiteOrigin === 'function' ? resolveSiteOrigin(d.id) : null;
    if (localOrigin) return localOrigin;        // offline harness (one port per site)
    // Opened straight off disk: the sibling folder IS the dashboard.
    if (isFile || isLocal) return d.local || ('/' + d.id + '/');
    return '/' + d.id + '/';                    // same origin (the container)
  }

  /* Put the live session in the fragment and navigate. */
  async function handoff(d) {
    // HubAuth is a top-level `const` in auth.js: a global LEXICAL binding, which
    // never appears on `window`. Typeof-test the binding itself, or this always
    // reads as "no session" and reloads in a loop.
    const session = await (typeof HubAuth !== 'undefined' ? HubAuth.session() : null);
    if (!session) { location.reload(); return; }               // session expired → re-gate
    const target = new URL(targetFor(d), location.href);
    // Same origin (one local server, or a relative sibling path): localStorage is
    // already shared, so the session is visible there with no handoff at all.
    if (target.origin === location.origin) { location.assign(target.toString()); return; }
    const frag = new URLSearchParams({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: String(session.expires_in || 3600),
      token_type: session.token_type || 'bearer',
      handoff: '1',
      // Tell the dashboard where the hub lives so its "go to the hub" links work
      // in every layout (production, one local server, or the four-port harness).
      hub: (typeof resolveHubUrl === 'function') ? resolveHubUrl() : '/',
    });
    target.hash = frag.toString();
    location.assign(target.toString());
  }

  /* ---------- theme ---------- */
  const root = document.documentElement;
  const savedTheme = localStorage.getItem('hub-theme');
  if (savedTheme) root.setAttribute('data-theme', savedTheme);
  const qTheme = new URLSearchParams(location.search).get('theme');
  if (qTheme === 'light' || qTheme === 'dark') {
    root.setAttribute('data-theme', qTheme);
    localStorage.setItem('hub-theme', qTheme);
  }
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    // Lives inside the account menu: sun/moon icon plus the theme you are in.
    themeBtn.innerHTML =
      `<span class="icon-stack">${svg('sun', 'icon-sun')}${svg('moon', 'icon-moon')}</span>` +
      `<span class="theme-item-label"></span>`;
    const isLight = () => root.getAttribute('data-theme') === 'light';
    const label = () => (isLight() ? 'Switch to dark theme' : 'Switch to light theme');
    const paint = () => {
      const t = themeBtn.querySelector('.theme-item-label');
      if (t) t.textContent = isLight() ? 'Dark theme' : 'Light theme';
      themeBtn.setAttribute('aria-label', label());
      themeBtn.title = label();
    };
    paint();
    themeBtn.addEventListener('click', () => {
      const next = isLight() ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      localStorage.setItem('hub-theme', next);
      paint();
    });
  }

  /* ---------- cards ---------- */
  const dashboards = (HUB.dashboards || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));

  grid.innerHTML = dashboards.map(d => {
    // The Supabase allowlist key is NOT always the folder name: the aging site
    // is `aging/` but its DASHBOARD_ID is `material-aging`.
    const authKey = d.authId || d.id;
    const ok = allowed.has(authKey);
    const accent = d.accent || 'var(--accent)';
    const ink = d.ink || '#0f141c';
    const localLink = (isFile && d.local && ok)
      ? `<a class="btn ghost" href="${esc(d.local)}">Open locally</a>` : '';

    // An allowed card is a real link (keyboard reachable). A locked card is an
    // inert span: no href, no tab stop, aria-disabled for screen readers.
    const hit = ok
      ? `<a class="card-hit" href="${esc(targetFor(d))}" data-dashboard="${esc(d.id)}">
           <span class="sr-only">Open the ${esc(d.title)}</span>
         </a>`
      : `<span class="card-hit" aria-disabled="true"></span>`;

    const cta = ok
      ? `<span class="btn cta" aria-hidden="true">Open dashboard ${svg('arrow', 'icon-directional')}</span>`
      : `<span class="btn cta is-locked"><span class="btn-label">No access</span>${svg('lock', 'btn-lock')}</span>`;

    return `
      <article class="card${ok ? '' : ' is-locked'}" style="--card-accent:${esc(accent)};--card-ink:${esc(ink)}">
        ${hit}
        <div class="card-head">
          <div class="card-icon">${svg(d.icon || 'box')}</div>
          <div>
            <h3 class="card-title">${esc(d.title)}</h3>
            <p class="card-byline">${esc(d.byline || '')}</p>
          </div>
        </div>
        <p class="card-desc">${esc(d.desc || '')}</p>
        ${ok ? '' : `<div class="card-meta">
            <span class="pill pill-locked">${svg('lock', 'pill-lock')}Not assigned to your account</span>
          </div>`}
        <div class="card-foot">
          <span class="card-actions">
            ${localLink}
            ${cta}
          </span>
        </div>
      </article>`;
  }).join('');

  // Wire the handoff. Locked cards have no anchor, so nothing to wire.
  grid.querySelectorAll('.card-hit[data-dashboard]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      handoff(dashboards.find(d => d.id === a.dataset.dashboard));
    });
  });

  const built = document.getElementById('built-line');
  if (built && HUB.built_at) built.textContent = 'Hub built: ' + HUB.built_at;

  // Account menu becomes available once we know who is signed in.
  const menu = document.getElementById('user-menu');
  if (menu) menu.classList.remove('hidden');

  // Test seam: lets the offline harness assert where a card would route without
  // actually navigating (and without re-deriving the rules in the test).
  window.__hubRoute = id => {
    const d = dashboards.find(x => x.id === id);
    return d ? targetFor(d) : null;
  };
});
