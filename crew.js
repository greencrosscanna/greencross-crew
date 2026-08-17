"use strict";
/* ─────────────────────────────────────────────────────────────────────────────
 *  GX Crew — HR / People app (frontend)
 *  Scaffold stub. Wired to the shared gx-client (window.GX → GX Core, JSONP).
 *  App key: crew.  Standalone spoke that FEEDS Leaderboard (perks + celebrations).
 *  Build the real views under /gxwhatsnext — see CLAUDE.md.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var APP   = 'crew';
  var mount = document.getElementById('app');

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function render(statusHtml) {
    mount.innerHTML = '';
    var card = el('section', 'gx-card');
    card.appendChild(el('h1', null, 'GX Crew'));
    card.appendChild(el('p', 'gx-muted',
      'HR &amp; People system-of-record — roster, compensation (incentive), time, permits, payroll export. ' +
      'Feeds perks &amp; a derived celebrations feed to Leaderboard.'));
    card.appendChild(el('p', null, statusHtml));
    mount.appendChild(card);
  }

  async function boot() {
    render('Connecting to GX Core…');
    try {
      if (!window.GX) throw new Error('gx-client not loaded');
      // Health probe: version_history for this app key. Succeeds once core-admin registers `crew`.
      await GX.jsonp('version_history', { app: APP });
      render('✅ Connected to GX Core (app key: <code>' + APP + '</code>). Scaffold live — run <code>/gxwhatsnext</code> to start building.');
    } catch (e) {
      render('⚠️ GX Core reachable but app key <code>' + APP + '</code> is pending core-admin registration (' +
        (e && e.message ? e.message : 'no response') + '). This is expected until the key is minted.');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
