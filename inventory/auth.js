/* Access gate — no login form. Sign-in happens at the hub only.

   Because localStorage is per-origin, a session created on another host is
   invisible here. The hub therefore navigates in with the tokens in the URL
   fragment; this file adopts them, strips the fragment, and then re-checks THIS
   dashboard's allowlist entry. A user can paste any valid token they like — if
   app_metadata.dashboards does not contain inventory, they are refused.

   There is deliberately NO file:// bypass: a dashboard opened directly (even as
   a local file) must still prove access. Unauthenticated users see a message
   and are sent to the hub. */
'use strict';

// Which dashboard this copy is. Must match the entry in app_metadata.dashboards.
const DASHBOARD_ID = 'inventory';

// How long to wait before declaring the access check hung.
const GATE_TIMEOUT_MS = 12000;

let SB = null;

document.addEventListener('DOMContentLoaded', () => {
  const screen = document.getElementById('auth-screen');
  const checking = document.getElementById('auth-checking');
  const noSession = document.getElementById('auth-nosession');
  const deniedEl = document.getElementById('auth-denied');
  const deniedEmail = document.getElementById('auth-denied-email');
  const deniedBack = document.getElementById('auth-denied-back');
  const errEl = document.getElementById('auth-error');

  let settled = false;
  let watchdog = null;

  function addRetry() {
    const card = document.querySelector('.auth-card');
    if (!card || card.querySelector('.auth-retry')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'auth-btn auth-btn-ghost auth-retry';
    b.textContent = 'Retry';
    b.onclick = () => location.reload();
    card.appendChild(b);
  }

  function settle() {
    settled = true;
    if (watchdog) clearTimeout(watchdog);
    // Once there is an outcome the "checking" block is dead weight; leaving it
    // un-hidden is how a stale spinner reappears if the screen is ever re-shown.
    if (checking) checking.classList.add('hidden');
  }

  function showState(state, message) {
    settle();
    screen.classList.remove('hidden');
    if (checking) checking.classList.toggle('hidden', state !== 'checking');
    if (noSession) noSession.classList.toggle('hidden', state !== 'nosession');
    if (deniedEl) deniedEl.classList.toggle('hidden', state !== 'denied');
    if (errEl) errEl.textContent = message || '';
  }

  /* Terminal failure: tell the user what broke and offer a retry. */
  function showFailure(message) {
    settle();
    screen.classList.remove('hidden');
    if (checking) checking.classList.add('hidden');
    if (noSession) noSession.classList.add('hidden');
    if (deniedEl) deniedEl.classList.add('hidden');
    if (errEl) errEl.textContent = message;
    addRetry();
  }

  function hubHref() {
    return (typeof resolveHubUrl === 'function') ? resolveHubUrl() : '/';
  }
  document.querySelectorAll('.auth-gohub').forEach(a => { a.href = hubHref(); });

  // "Back to hub" is a dedicated topbar button. Set its href BEFORE start()
  // strips the hand-off fragment, or the hub= param the hub sent is lost and the
  // link falls back to a relative path (wrong port in the four-port harness).
  const hubLink = document.getElementById('hub-link');
  if (hubLink) hubLink.href = hubHref();

  // ---- dependencies, checked WITHOUT returning silently -------------------
  const missing = [];
  if (!window.supabase) missing.push('supabase-js (assets/supabase-js.min.js)');
  // SUPABASE_URL / SUPABASE_ANON_KEY are top-level consts in auth-config.js —
  // global lexical bindings, visible here but NOT attached to window.
  if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
    missing.push('auth-config.js');
  }
  if (missing.length) {
    console.error('access gate cannot start — missing:', missing.join(', '));
    showFailure('Could not load ' + missing.join(' and ') +
                '. Reload the page; if this persists the file is missing from the site folder.');
    return;
  }

  // detectSessionInUrl off: the hand-off is parsed explicitly below so the
  // behaviour does not depend on library version defaults.
  SB = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { detectSessionInUrl: false },
  });

  function hasAccess(user) {
    const dashboards = (user && user.app_metadata && user.app_metadata.dashboards) || [];
    return Array.isArray(dashboards) && dashboards.includes(DASHBOARD_ID);
  }

  function enter(user) {
    fillUserInfo(user);
    settle();
    screen.classList.add('hidden');
    // Only now is the dashboard allowed to load data and render.
    document.dispatchEvent(new CustomEvent('auth:ready', { detail: { user } }));
  }

  /* Adopt the session the hub handed over in the fragment. */
  async function adoptHandoff() {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!raw) return null;
    const h = new URLSearchParams(raw);
    const access = h.get('access_token');
    const refresh = h.get('refresh_token');
    if (!access || !refresh) return null;
    // Strip the fragment BEFORE awaiting: the tokens leave the address bar and
    // the history entry even if setSession rejects them.
    history.replaceState(null, '', location.pathname + location.search);
    const { error } = await SB.auth.setSession({ access_token: access, refresh_token: refresh });
    return error ? { error } : { adopted: true };
  }

  /* Show the gate message, then send the user to the hub. The delay lets the
     message be read; the redirect is not instant so a hub outage or a loop
     cannot silently bounce the user. */
  function redirectToHub(delayMs) {
    const href = hubHref();
    setTimeout(() => { location.href = href; }, delayMs);
  }

  async function start() {
    try {
      const res = await adoptHandoff();
      if (res && res.error) {
        return showState('nosession', 'That sign-in hand-off is no longer valid. Sign in at the hub again.');
      }
      const { data: { session } } = await SB.auth.getSession();
      if (!session) {
        // Not authenticated: show the message, then go to the hub.
        showState('nosession');
        return redirectToHub(2500);
      }
      if (!hasAccess(session.user)) {
        if (deniedEmail) deniedEmail.textContent = session.user.email || '';
        showState('denied');
        return redirectToHub(4000);
      }
      enter(session.user);
    } catch (e) {
      console.error('access check failed:', e);
      showFailure('Access check failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // Watchdog: any unresolved await (dead host, stalled request, blocked fetch)
  // becomes a visible, actionable message instead of a permanent spinner.
  watchdog = setTimeout(() => {
    if (settled) return;
    showFailure('The access check did not finish. Check your connection, then sign in at the hub and try again.');
  }, GATE_TIMEOUT_MS);

  if (deniedBack) {
    deniedBack.onclick = async () => { await SB.auth.signOut(); location.href = hubHref(); };
  }

  start();

  /* ---------- user menu dropdown ---------- */
  const userMenu = document.getElementById('user-menu');
  const userBtn = document.getElementById('user-btn');
  const userDropdown = document.querySelector('.user-dropdown');
  const userNameEl = document.getElementById('user-name');
  const userEmailEl = document.getElementById('user-email');

  function fillUserInfo(user) {
    if (userNameEl) {
      const fullName = (user && (user.user_metadata && user.user_metadata.full_name)) || '';
      userNameEl.textContent = fullName || (user && user.email ? user.email.split('@')[0] : 'Account');
    }
    if (userEmailEl) userEmailEl.textContent = user && user.email ? user.email : '';
  }

  if (userBtn && userDropdown) {
    userBtn.onclick = e => {
      e.stopPropagation();
      userDropdown.classList.toggle('hidden');
    };
    document.addEventListener('click', e => {
      if (userMenu && !userMenu.contains(e.target)) userDropdown.classList.add('hidden');
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') userDropdown.classList.add('hidden');
    });
  }

  // Sign out: clear the session and return to the hub. (This handler was dropped
  // in an earlier revision, which is why the button appeared to do nothing.)
  const lo = document.getElementById('logout');
  if (lo) {
    lo.onclick = async () => {
      try { await SB.auth.signOut(); } catch (e) { console.error('sign out failed:', e); }
      location.href = hubHref();
    };
  }

  /* ---------- change password (unchanged) ---------- */
  const pwModal = document.getElementById('pw-modal');
  const pwForm = document.getElementById('pw-form');
  const pwCurrent = document.getElementById('pw-current');
  const pwNew = document.getElementById('pw-new');
  const pwConfirm = document.getElementById('pw-confirm');
  const pwMsg = document.getElementById('pw-msg');
  const pwSubmit = document.getElementById('pw-submit');
  const pwCancel = document.getElementById('pw-cancel');
  const changeBtn = document.getElementById('change-password');

  function openPwModal() {
    pwMsg.textContent = '';
    pwCurrent.value = pwNew.value = pwConfirm.value = '';
    pwModal.classList.remove('hidden');
    pwCurrent.focus();
  }
  function closePwModal() { pwModal.classList.add('hidden'); }

  if (changeBtn && pwForm) {
    changeBtn.onclick = openPwModal;
    pwCancel.onclick = closePwModal;
    pwModal.addEventListener('click', e => { if (e.target === pwModal) closePwModal(); });

    pwForm.addEventListener('submit', async e => {
      e.preventDefault();
      pwMsg.textContent = '';
      const current = pwCurrent.value || '';
      const next = pwNew.value || '';
      const confirm = pwConfirm.value || '';

      if (next.length < 8) { pwMsg.textContent = 'New password must be at least 8 characters.'; return; }
      if (next !== confirm) { pwMsg.textContent = 'New passwords do not match.'; return; }

      pwSubmit.disabled = true;
      pwSubmit.textContent = 'Updating…';

      const { data: { user: u } } = await SB.auth.getUser();
      const email = u && u.email ? u.email : '';
      const { error: signInErr } = await SB.auth.signInWithPassword({ email, password: current });
      if (signInErr) {
        pwMsg.textContent = 'Current password is incorrect.';
        pwSubmit.disabled = false;
        pwSubmit.textContent = 'Update password';
        return;
      }

      const { error: updateErr } = await SB.auth.updateUser({ password: next });
      pwSubmit.disabled = false;
      pwSubmit.textContent = 'Update password';
      if (updateErr) {
        pwMsg.textContent = updateErr.message;
        return;
      }

      pwMsg.style.color = 'var(--good)';
      pwMsg.textContent = 'Password updated.';
      setTimeout(closePwModal, 1200);
    });
  }
});
