/* Planner: the scale must be verified, never silently assumed (SPEC 14.1) - the planner side.
 *
 *   PL.scale.verified()     project.scale.verified (a project without the flag - hand-made - counts as verified)
 *   PL.scale.needed()       there is a plan and its scale is not verified: the estimate is only as good as a guess
 *   PL.scale.area()         the active floor's area in m² ({areaM2, allM2, rooms, largest, smallest}) or null
 *   PL.scale.open()         the floor-plan editor's "Měřítko" card (WH.editor.openScale)
 *   PL.scale.syncBadge()    while the Wi-Fi view is on screen and the scale is not verified, the header's estimate badge
 *                           reads "Měřítko neověřeno" (amber, its "?" explains why, the words open the editor's scale card);
 *                           the badge goes back to "Orientační odhad" as soon as the scale is set or the view is left
 * Only UI lives here; scale data and areas are the engine's (scale.verified, project.planArea). */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  const PL = (WH.planner = WH.planner || {});
  const t = (k, p) => WH.i18n.t(k, p);
  const el = (...a) => WH.util.el(...a);
  const ui = () => WH.ui;
  const SC = (PL.scale = {});

  SC.verified = () => { const p = PL.P(); return !p || !p.scale || p.scale.verified !== false; };
  SC.needed = () => { const p = PL.P(); return !!(p && p.plan && p.plan.rooms.length && !SC.verified()); };
  SC.area = () => {
    const p = PL.P();
    if (!p || !p.plan.rooms.length) return null;
    try { return WH.engine.project.planArea(p); } catch (e) { PL.report(e, 'scale.area', { bug: true }); return null; }
  };
  /** "58,3 m²" */
  SC.fmt = (m2) => `${WH.util.fmt(m2, m2 < 100 ? 1 : 0)}${WH.util.NBSP}m²`;
  SC.open = () => {
    const ed = WH.editor;
    if (ed && typeof ed.openScale === 'function') ed.openScale();
    else if (WH.views) WH.views.go('editor');
  };

  // ---------------------------------------------------------------------------------------------------------------
  // the header's estimate badge (the only place every view shows) - restyled while the planner is on screen
  // ---------------------------------------------------------------------------------------------------------------
  let go = null;
  let shown = false;
  let lang = '';
  SC.syncBadge = () => {
    const b = typeof document !== 'undefined' ? document.getElementById('estimate-badge') : null;
    if (!b) return;
    const want = !!(PL.S && PL.S.visible) && SC.needed();
    const hint = b.querySelector('.hint');
    if (want === shown && (!want || lang === WH.i18n.lang)) return;
    shown = want;
    lang = WH.i18n.lang;
    b.classList.toggle('pl-scaleb', want);
    if (want) {
      if (!go) {
        go = el('button.pl-scaleb__go', { type: 'button' });
        go.addEventListener('click', () => SC.open());
      }
      go.replaceChildren(ui().icon('ruler', 16), el('span.pl-scaleb__long', t('planner.scale.badge')), el('span.pl-scaleb__short', t('planner.scale.badgeShort')), ui().icon('chevron-right', 16));
      go.setAttribute('aria-label', t('planner.scale.badgeAria'));
      if (go.parentNode !== b) b.insertBefore(go, hint || null);
    } else if (go && go.parentNode) go.remove();
    if (hint) {
      const k = want ? 'scaleUnverified' : 'estimate';
      hint.setAttribute('data-hint', k);
      hint.setAttribute('aria-label', t('ui.hint.about', { topic: t(`help.${k}.t`) }));
    }
  };
  // (called from the stage's toolbar repaint: every project change, view switch and language change passes there)
})();
