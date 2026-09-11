/* Hub login gate — the ONLY place a password is entered.

   Session storage is per-origin, so this login cannot be read by
   aging./inventory./purchasing.abederp.com. app.js hands the session to a
   dashboard by putting the tokens in the URL fragment on the way out; each
   dashboard adopts them and re-checks its own allowlist entry.

   When the user is signed in, this file publishes window.HubAuth so app.js can
   read the session and the allowlist. */
'use strict';

const HubAuth = (() => {
  let SB = null;
  let currentUser = null;

  const els = {};
  const $ = id => document.getElementById(id);

  function dashboardsOf(user) {
    const list = (user && user.app_metadata && user.app_metadata.dashboards) || [];
    return Array.isArray(list) ? list : [];
  }

  function showState(state) {
    const screen = els.screen;
    if (!screen) return;
    screen.classList.toggle('hidden', state === 'ready');
    els.form.classList.toggle('hidden', state !== 'login');
    els.checking.classList.toggle('hidden', state !== 'checking');
    els.denied.classList.toggle('hidden', state !== 'denied');
    if (state === 'login') setTimeout(() => els.email && els.email.focus(), 30);
  }

  function paintUser(user) {
    if (els.userName) {
      const meta = user && user.user_metadata ? user.user_metadata.full_name : '';
      els.userName.textContent = meta || (user && user.email ? user.email.split('@')[0] : 'Account');
    }
    if (els.userEmail) els.userEmail.textContent = (user && user.email) || '';
  }

  function enter(user) {
    const list = dashboardsOf(user);
    if (!list.length) {
      currentUser = user;
      if (els.deniedEmail) els.deniedEmail.textContent = (user && user.email) || '';
      showState('denied');
      return;
    }
    currentUser = user;
    paintUser(user);
    showState('ready');
    document.dispatchEvent(new CustomEvent('auth:ready', { detail: { user, dashboards: list } }));
  }

  function init() {
    els.screen = $('auth-screen');
    els.form = $('auth-form');
    els.checking = $('auth-checking');
    els.denied = $('auth-denied');
    els.email = $('auth-email');
    els.password = $('auth-password');
    els.error = $('auth-error');
    els.submit = $('auth-submit');
    els.deniedEmail = $('auth-denied-email');
    els.deniedBack = $('auth-denied-back');
    els.userName = $('user-name');
    els.userEmail = $('user-email');

    if (!window.supabase || typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
      // Fail visible rather than showing a dead login.
      console.error('supabase-js or auth-config.js missing');
      if (els.checking) els.checking.textContent = 'Auth library failed to load. Reload the page.';
      return;
    }
    // detectSessionInUrl: the hub never receives a handoff, so keep parsing off
    // and control the flow explicitly.
    SB = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { detectSessionInUrl: false },
    });

    // Restore an existing session (persisted in localStorage by supabase-js).
    SB.auth.getSession()
      .then(({ data: { session } }) => { session ? enter(session.user) : showState('login'); })
      .catch(() => showState('login'));

    if (els.form) {
      els.form.addEventListener('submit', async e => {
        e.preventDefault();
        els.error.textContent = '';
        els.submit.disabled = true;
        els.submit.textContent = 'Signing in…';
        const { data, error } = await SB.auth.signInWithPassword({
          email: (els.email.value || '').trim(),
          password: els.password.value || '',
        });
        els.submit.disabled = false;
        els.submit.textContent = 'Sign in';
        if (error) { els.error.textContent = error.message; return; }
        els.password.value = '';
        enter(data.session ? data.session.user : null);
      });
    }

    if (els.deniedBack) {
      els.deniedBack.onclick = async () => { await SB.auth.signOut(); location.reload(); };
    }

    /* user menu (sign out) */
    const menu = $('user-menu');
    const btn = $('user-btn');
    const dropdown = document.querySelector('.user-dropdown');
    if (btn && dropdown) {
      btn.onclick = e => { e.stopPropagation(); dropdown.classList.toggle('hidden'); };
      document.addEventListener('click', e => {
        if (menu && !menu.contains(e.target)) dropdown.classList.add('hidden');
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') dropdown.classList.add('hidden');
      });
    }
    const lo = $('logout');
    if (lo) {
      lo.onclick = async () => { await SB.auth.signOut(); location.reload(); };
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    get user() { return currentUser; },
    dashboards() { return dashboardsOf(currentUser); },
    /* Live session for the handoff. Refreshes if the access token has expired. */
    async session() {
      if (!SB) return null;
      const { data: { session } } = await SB.auth.getSession();
      return session || null;
    },
    async signOut() { if (SB) await SB.auth.signOut(); },
  };
})();
