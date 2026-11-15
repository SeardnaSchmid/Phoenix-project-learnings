'use strict';
// DOM UI: title screen, HUD, tools, station panel, board, modals.

const $ = s => document.querySelector(s);
const UI = {
  screen: 'title', G: null, ghost: null, demo: null, levelIdx: 0,
  hover: null, selected: null, targeting: null, lastSpeed: 1,
  modal: false, mentorShown: 0, hintI: 0, save: loadSave(),
  validTarget: s => !!(UI.targeting && UI.G && TOOLS[UI.targeting].valid(UI.G, s)),
};

function loadSave() {
  try { return JSON.parse(localStorage.getItem('flowfactory.v2')) || {}; } catch { return {}; }
}
function persist() {
  try { localStorage.setItem('flowfactory.v2', JSON.stringify(UI.save)); } catch { /* storage unavailable */ }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function starHtml(n) {
  return `<span class="stars">${[0, 1, 2].map(i => `<span class="${i < n ? 'on' : 'off'}">★</span>`).join('')}</span>`;
}

// ---------- theme ----------
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
function applyTheme(t) {
  UI.save.theme = t; persist();
  document.body.classList.toggle('theme-dark', t === 'dark');
  document.body.classList.toggle('theme-light', t === 'light');
  setPalette(t);
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.innerHTML = (t === 'dark' ? SUN : MOON) + (b.id === 'btnThemeTitle' ? (t === 'dark' ? 'Light mode' : 'Dark mode') : '');
    b.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  });
}
function toggleTheme() { applyTheme(UI.save.theme === 'light' ? 'dark' : 'light'); }

// ---------- title ----------
function unlocked(i) { return i === 0 || UI.save.unlockAll || ((UI.save.stars || {})[i - 1] || 0) >= 1; }
function renderTitle() {
  const grid = $('#levelGrid');
  grid.innerHTML = '';
  LEVELS.forEach((L, i) => {
    const b = document.createElement('button');
    const ok = unlocked(i);
    b.className = 'level-card' + (ok ? '' : ' locked');
    b.innerHTML = `<span class="lc-num">${i}</span><span class="lc-body"><b>${esc(L.title)}</b><small>${esc(L.concept)}</small></span>${starHtml((UI.save.stars || {})[i] || 0)}`;
    if (ok) b.onclick = () => startLevel(i);
    grid.appendChild(b);
  });
}
function showTitle() {
  UI.screen = 'title'; UI.G = null; UI.ghost = null; UI.targeting = null; UI.selected = null;
  $('#vignette').style.opacity = 0;
  closeModal();
  $('#hud').classList.add('hidden');
  $('#title').classList.remove('hidden');
  document.body.classList.add('title-mode');
  endTourUi();
  $('#callout').classList.add('hidden');
  renderTitle();
}

// ---------- level start ----------
function startLevel(i) {
  const L = LEVELS[i];
  UI.levelIdx = i;
  closeModal();
  $('#callout').classList.add('hidden');
  UI.G = newGame(L);
  UI.G.speed = 1;
  // the untouched twin: same seed, no toolbox decisions
  UI.ghost = L.tutorial || L.tour ? null : newGame(L, { seed: UI.G.seed, ghost: true });
  UI.screen = 'game'; UI.mentorShown = 0; UI.hintI = 0; UI.selected = null; UI.targeting = null;
  $('#title').classList.add('hidden');
  $('#hud').classList.remove('hidden');
  document.body.classList.remove('title-mode');
  $('#board').classList.add('hidden');
  $('#stationPanel').classList.add('hidden');
  $('#feed').innerHTML = '';
  $('#log').dataset.sig = '-';
  endTourUi();
  $('#log').dataset.first = '';
  // tools discovered in earlier runs stay in the toolbox
  UI.G.disc = Object.assign({}, UI.save.disc || {});
  UI.G.discT = {}; UI.G.toolT = {};
  UI.newTools = new Set();
  buildHud();
  showBanner(`Shift ${L.id}`, L.title, L.concept, 3600);
  if (L.tour) { UI.G.tourStep = 0; renderTour(); }
}

// Cold open: a short title card over the running floor instead of a modal.
let bannerTimer = 0;
function showBanner(kicker, title, sub, ms) {
  const b = $('#banner');
  b.innerHTML = `<div class="bn-k">${esc(kicker)}</div><div class="bn-t">${esc(title)}</div>${sub ? `<div class="bn-s">${esc(sub)}</div>` : ''}`;
  b.classList.remove('hidden', 'out'); void b.offsetWidth; b.classList.add('in');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.classList.add('out'); bannerTimer = setTimeout(() => b.classList.add('hidden'), 600); }, ms);
}

// Point at a KPI card the first time it matters, so the number gets a meaning.
let calloutTimer = 0;
function showCallout({ kpi, title, text }) {
  const card = $('#kv-' + kpi)?.closest('.kpi'), c = $('#callout');
  if (!card || UI.screen !== 'game' || UI.modal) return;
  const v = computeKpis(UI.G)[kpi];
  c.innerHTML = `<b>${esc(title)}${v != null ? `: ${Math.round(v)}` : ''}</b><p>${esc(text)}</p><small>click to dismiss</small>`;
  c.classList.remove('hidden');
  const r = card.getBoundingClientRect(), cr = c.getBoundingClientRect();
  c.style.left = clamp(r.left + r.width / 2 - cr.width / 2, 8, innerWidth - cr.width - 8) + 'px';
  c.style.top = (r.top - cr.height - 14) + 'px';
  c.style.setProperty('--ax', (r.left + r.width / 2 - parseFloat(c.style.left)) + 'px');
  card.classList.remove('spot'); void card.offsetWidth; card.classList.add('spot');
  const hide = () => { c.classList.add('hidden'); card.classList.remove('spot'); };
  c.onclick = hide;
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(hide, 9000);
}

// ---------- discovery: the toolbox grows as the player sees problems ----------
function discoverable(G, key) { const d = G.L.discover && G.L.discover[key]; return d || null; }
function toolVisible(G, key) { return !discoverable(G, key) || !!G.disc[key]; }
function checkDiscoveries(G) {
  const D = G.L.discover;
  if (!D || G.ended) return;
  for (const key of Object.keys(D)) {
    const d = D[key];
    if (G.disc[key] || (d.after && !G.disc[d.after])) continue;
    if (d.after && !G.owned[d.after]) continue;
    const base = d.after ? (G.toolT[d.after] ?? G.t) : 0;
    if (d.when(G) || (d.late != null && G.t > base + d.late)) discover(G, key);
  }
}
function discover(G, key) {
  const d = G.L.discover[key];
  G.disc[key] = true; G.discT[key] = G.t;
  UI.save.disc = Object.assign(UI.save.disc || {}, { [key]: true }); persist();
  UI.newTools.add(key);
  mentorSay(G, d.say);
  buildTools();
  const t = TOOLS[key];
  showBanner('New tool discovered', t.name, 'It\'s in your toolbox now. You keep it for later shifts.', 2600);
}

function buildHud() {
  const G = UI.G, L = G.L;
  $('#tbNum').textContent = L.id;
  $('#tbTitle').textContent = L.title;
  $('#tbConcept').textContent = L.concept;
  // KPIs
  const k = $('#kpis');
  k.innerHTML = '';
  for (const key of L.kpis) {
    const m = KPI_META[key];
    const goal = L.goals.find(g => g.kpi === key);
    const el = document.createElement('div');
    el.className = 'kpi panel';
    el.innerHTML = `<div class="l"><span>${m.label}</span><span class="i" data-tip="${esc(m.info)}">ⓘ</span></div>
      <div class="v-row"><div class="v" id="kv-${key}">–</div><span class="watch" id="kw-${key}"></span></div><canvas id="ks-${key}"></canvas>
      <div class="target">${goal ? 'Goal ' + (goal.op === '<=' ? '≤ ' : '≥ ') + m.fmt(goal.val) + ' ' + m.unit : '&nbsp;'}</div>`;
    k.appendChild(el);
    attachMarkerHover(el.querySelector('canvas'));
  }
  // goals
  $('#goals').innerHTML = L.goals.map((g, i) => `<li id="goal-${i}"${g.tip ? ` data-tip="${esc(g.tip)}"` : ''}><span class="ck"></span><span class="gl">${esc(g.label)}</span><span class="gv"></span></li>`).join('');
  $('#steps').innerHTML = L.steps
    ? `<h3 style="margin-top:4px">Five focusing steps</h3><div class="steps">${['Identify', 'Exploit', 'Subordinate', 'Elevate', 'Repeat'].map(s => `<div class="step" data-step="${s.toLowerCase()}">${s}</div>`).join('')}</div>`
    : '';
  buildTools();
  updateHud();
}

// Icon + category per tool. Categories describe the lever, never whether it is a trap.
const TOOL_CATS = {
  see: { label: 'Visibility', color: 'biz' },
  flow: { label: 'Flow', color: 'int' },
  people: { label: 'People', color: 'accent' },
  risk: { label: 'Risk & quality', color: 'chg' },
};
const I = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TOOL_LOOK = {
  kanban: ['see', I('<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>')],
  singleIntake: ['see', I('<path d="M3 4h18l-7 8v6l-4 2v-8z"/>')],
  freeze: ['flow', I('<path d="M12 2v20M4.9 7l14.2 10M19.1 7 4.9 17"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/>')],
  teamOvertime: ['people', I('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>')],
  markConstraint: ['see', I('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>')],
  protectHero: ['people', I('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m12 8 1.2 2.6 2.8.3-2.1 1.9.6 2.8L12 14.2l-2.5 1.4.6-2.8L8 10.9l2.8-.3z"/>')],
  rope: ['flow', I('<path d="M4 12h3l2-5 3 10 2-5h6"/>')],
  runbook: ['people', I('<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-4a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h5z"/>')],
  hire: ['people', I('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M19 8v6M16 11h6"/>')],
  heroOvertime: ['people', I('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/><path d="M17 3v4M15 5h4"/>')],
  wipLimits: ['flow', I('<path d="M4 6h16"/><rect x="5" y="9" width="4" height="11" rx="1"/><rect x="10" y="12" width="4" height="8" rx="1"/><rect x="15" y="10" width="4" height="10" rx="1"/>')],
  utilDrive: ['flow', I('<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 5-6"/>')],
  debtSlider: ['risk', I('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>')],
  monitoring: ['see', I('<path d="M3 12h4l3-8 4 16 3-8h4"/>')],
  firefighters: ['people', I('<path d="M12 2c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 2-7 2 1 3 3 3 5 1-2 1-5 1-9z"/>')],
  preapprove: ['risk', I('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>')],
  shiftLeft: ['risk', I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>')],
  cutScope: ['risk', I('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.6 20 18M8.6 16.4 20 6"/>')],
  moreApprovers: ['risk', I('<path d="M9 3h6v5l3 3H6l3-3z"/><path d="M5 15h14v3H5zM4 21h16"/>')],
  deployAuto: ['flow', I('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>')],
  batchSlider: ['flow', I('<path d="m12 3 8 4v10l-8 4-8-4V7z"/><path d="m4 7 8 4 8-4M12 11v10"/>')],
  autoTests: ['see', I('<path d="M9 3h6M10 3v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4A1.5 1.5 0 0 0 20 19l-6-10V3"/><path d="M7 15h10"/>')],
  chaosDrill: ['risk', I('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>')],
  skipTests: ['flow', I('<path d="m4 5 8 7-8 7zM12 5l8 7-8 7z"/>')],
};

function buildTools() {
  const G = UI.G, box = $('#tools');
  box.innerHTML = '';
  if (!G.L.tools.length) {
    box.innerHTML = '<div class="t-desc" style="color:var(--muted);font-size:13px;line-height:1.5">No tools today. Just learn to read the floor: work types, queues, the KPIs at the bottom.</div>';
    return;
  }
  for (const key of G.L.tools.filter(k => toolVisible(G, k))) {
    const t = TOOLS[key];
    const el = document.createElement('div');
    el.className = 'tool' + (UI.newTools.has(key) ? ' new' : ''); el.dataset.key = key;
    el.addEventListener('mouseenter', () => { UI.newTools.delete(key); el.classList.remove('new'); });
    let ctl;
    if (t.kind === 'slider') {
      ctl = `<div class="slider-row"><input type="range" min="${t.min}" max="${t.max}" step="${t.step}"><b></b></div>`;
    } else {
      ctl = `<button class="t-act"></button>`;
    }
    const [cat, icon] = TOOL_LOOK[key] || ['flow', ''];
    el.classList.add('cat-' + cat);
    el.dataset.tip = `<b>${esc(t.name)}</b>${t.cost ? ` · ◆${t.cost}` : ''}<br>${esc(t.desc)}`;
    el.innerHTML = `<div class="t-icon">${icon}</div><div class="t-main">
        <div class="t-name">${esc(t.name)}</div>
        <div class="t-cat">${TOOL_CATS[cat].label}${typeof t.step === 'string' ? ` · ${t.step}` : ''}</div></div>${ctl}`;
    if (t.kind === 'slider') {
      const inp = el.querySelector('input');
      inp.value = t.get(G);
      let before = t.get(G);
      inp.oninput = () => { t.set(G, Number(inp.value)); updateTools(); };
      inp.onchange = () => { const v = t.get(G); if (v !== before) logSlider(key, before, v); before = v; };
    } else {
      el.querySelector('.t-act').onclick = () => useTool(key);
    }
    box.appendChild(el);
  }
  const hidden = G.L.tools.filter(k => !toolVisible(G, k)).length;
  for (let i = 0; i < hidden; i++) {
    const el = document.createElement('div');
    el.className = 'tool locked-slot';
    el.dataset.tip = 'Not discovered yet. Look closely at the floor: when you understand a problem, the tool for it shows up here.';
    el.innerHTML = `<div class="t-icon">${I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>')}</div><div class="t-main"><div class="t-name">Undiscovered tool</div><div class="t-cat">investigate the floor</div></div>`;
    box.appendChild(el);
  }
  updateTools();
}

function updateTools() {
  const G = UI.G;
  if (!G) return;
  document.querySelectorAll('#tools .tool[data-key]').forEach(el => {
    const key = el.dataset.key, t = TOOLS[key];
    const uses = G.toolUses[key] || 0;
    const owned = t.kind === 'buy' && !t.repeat && uses > 0;
    el.classList.toggle('owned', owned);
    el.classList.toggle('targeting', UI.targeting === key);
    if (t.kind === 'slider') {
      const inp = el.querySelector('input'), lock = t.locked && t.locked(G);
      if (document.activeElement !== inp) inp.value = t.get(G);
      inp.disabled = !!lock;
      el.querySelector('b').textContent = lock ? 'locked' : t.fmt(t.get(G));
      return;
    }
    const btn = el.querySelector('.t-act');
    const poor = t.cost && G.budget < t.cost;
    btn.classList.remove('on');
    if (t.kind === 'toggle') {
      const on = t.get(G);
      btn.textContent = on ? 'On' : 'Off';
      btn.classList.toggle('on', on);
      btn.disabled = false;
    } else if (t.kind === 'target') {
      const anyValid = G.st.some(s => t.valid(G, s));
      btn.textContent = UI.targeting === key ? 'Pick…' : t.cost ? `Pick ◆${t.cost}` : 'Pick';
      btn.disabled = poor || !anyValid;
      if (!anyValid && key === 'markConstraint' && G.steps.identify) { btn.textContent = 'Done ✓'; el.classList.add('owned'); }
      if (!anyValid && key === 'runbook' && G.hero.doc) btn.textContent = 'Writing…';
      if (!anyValid && key === 'runbook' && !G.hero.doc) btn.textContent = 'All done ✓';
    } else if (owned) {
      btn.textContent = 'Active ✓'; btn.disabled = true;
    } else {
      btn.textContent = (t.repeat ? 'Use' : t.cost ? 'Buy' : 'Unlock') + (t.cost ? ` ◆${t.cost}` : '');
      btn.disabled = poor;
    }
  });
}

function useTool(key, s, confirmed) {
  const G = UI.G, t = TOOLS[key];
  if (t.kind === 'toggle') {
    const v = !t.get(G);
    if (v && !confirmed) return confirmTool(key, null);
    t.set(G, v);
    G.toolUses[key] = (G.toolUses[key] || 0) + 1;
    if (v) logDecision(G, toolDecision(G, key, null, { label: t.name + ' · on' }));
    else logDecision(G, toolDecision(G, key, null, { label: t.name + ' · off', trap: false, expect: {}, fixed: 'info',
      why: t.trap ? 'You switched the trap off again. Good call.' : 'Switched off again.' }));
    updateHud();
    return;
  }
  if (t.cost && G.budget < t.cost) { flashBudget(); return; }
  if (t.kind === 'target' && !s) {
    UI.targeting = UI.targeting === key ? null : key;
    showTargetHint();
    updateTools();
    return;
  }
  if (t.kind === 'target' && !t.valid(G, s)) return;
  if (!confirmed) return confirmTool(key, s);
  const dec = toolDecision(G, key, s);
  G.budget -= t.cost || 0;
  G.toolUses[key] = (G.toolUses[key] || 0) + 1;
  G.toolT[key] = G.toolT[key] ?? G.t;
  t.apply(G, s);
  if (t.reveal) showBanner(...t.reveal(G), 4200);
  if (t.callout) setTimeout(() => showCallout(t.callout), 900);
  if (key === 'markConstraint') {
    const ok = G.steps.identify && G.marked === s.i;
    Object.assign(dec, { fixed: ok ? 'helped' : 'wrong', expect: {},
      why: ok ? FEEDBACK.markConstraint.works : `${s.name} wasn't the constraint. Busy isn't the same as constraining: look for where work waits longest.` });
  }
  logDecision(G, dec);
  UI.targeting = null;
  showTargetHint();
  updateHud();
}

// Every tool is a bet: ask before spending, so the player commits to an expectation.
function confirmTool(key, s) {
  const G = UI.G, t = TOOLS[key];
  const verb = t.kind === 'toggle' ? 'Turn on' : t.kind === 'target' ? 'Apply' : t.repeat ? 'Use' : t.cost ? 'Buy' : 'Unlock';
  const card = openModal(`
    <div class="eyebrow">Decision · day ${G.t.toFixed(1)}</div>
    <h2>${verb} "${esc(t.name)}"${s ? ` at ${esc(s.name)}` : ''}?</h2>
    <p>${esc(t.desc)}</p>
    ${t.cost ? `<div class="confirm-cost"><span><span class="gem"></span> Cost <b>${t.cost}</b></span><span>Budget after <b>${Math.floor(G.budget - t.cost)}</b></span></div>` : ''}
    <p class="muted" style="font-size:13px">Not every tool fits every problem. Which problem should this solve, and which KPI do you expect to move? Your decision log will show whether it did.</p>
    <div class="modal-actions"><button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>${verb}${t.cost ? ` for ◆${t.cost}` : ''}</button></div>`);
  card.querySelector('[data-no]').onclick = () => { closeModal(); UI.targeting = null; showTargetHint(); updateTools(); };
  card.querySelector('[data-yes]').onclick = () => { closeModal(); useTool(key, s, true); };
}

function logSlider(key, from, to) {
  const G = UI.G, t = TOOLS[key];
  const f = key === 'debtSlider' ? FEEDBACK[to > from ? 'debtUp' : 'debtDown'] : FEEDBACK[to < from ? 'batchDown' : 'batchUp'];
  logDecision(G, { key, kind: 'tool', merge: key, label: `${t.name} → ${t.fmt(to)}`, trap: false, why: f.works,
    expect: f.expect, delay: f.delay, station: stationIdx(G, f.focus) });
}

function flashBudget() {
  const b = $('.tb-budget');
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
}

function showTargetHint() {
  const h = $('#targetHint');
  if (UI.targeting) { h.textContent = `${TOOLS[UI.targeting].name}: click a highlighted station · Esc to cancel`; h.classList.remove('hidden'); }
  else h.classList.add('hidden');
}

// ---------- HUD update ----------
function goalMet(G, g, k) {
  if (g.test) return g.test(G);
  let v = k[g.kpi];
  if (v == null) return false;
  return g.op === '<=' ? v <= g.val : v >= g.val;
}
function goalShow(G, g, k) {
  if (g.show) return g.show(G);
  const v = k[g.kpi], m = KPI_META[g.kpi];
  return v == null ? '–' : m.fmt(v) + (m.unit === '%' ? '%' : '');
}
function fogged(G, key) { return G.L.fog && !G.owned.kanban && (key === 'wip' || key === 'lead'); }

function updateHud() {
  const G = UI.G;
  if (!G) return;
  const L = G.L, k = G.kpi;
  $('#tbDay').textContent = `${Math.min(L.days, G.t).toFixed(1)} / ${L.days}`;
  $('#tbDayBar').style.width = Math.min(100, G.t / L.days * 100) + '%';
  updatePatience(G);
  $('#tbBudget').textContent = Math.floor(G.budget);
  document.querySelectorAll('#speedBtns button').forEach(b => b.classList.toggle('on', Number(b.dataset.sp) === G.speed));
  $('#btnBoard').classList.toggle('on', !$('#board').classList.contains('hidden'));
  $('#pausedBadge').classList.toggle('hidden', !(G.speed === 0 && !UI.modal));

  for (const key of L.kpis) {
    const m = KPI_META[key], el = $('#kv-' + key);
    if (!el) continue;
    const v = k[key];
    const goal = L.goals.find(g => g.kpi === key);
    if (fogged(G, key)) { el.innerHTML = '??<small>hidden</small>'; el.className = 'v'; }
    else {
      el.innerHTML = (v == null ? '–' : m.fmt(v)) + `<small>${m.unit}</small>`;
      el.className = 'v' + (goal && v != null ? (goalMet(G, goal, k) ? ' good' : ' bad') : '');
    }
    sparkline($('#ks-' + key), G.seriesT, fogged(G, key) ? [] : (G.series[key] || []), PAL.crate[m.color], L.days, G.decisions);
  }

  checkDiscoveries(G);
  let lockedShown = false;
  L.goals.forEach((g, i) => {
    const li = $('#goal-' + i);
    if (!li) return;
    const shown = !g.reveal || g.reveal(G);
    if (li.classList.contains('locked') === shown) {
      li.classList.toggle('locked', !shown);
      li.querySelector('.gl').textContent = shown ? g.label : 'Next goal: find the problem first';
      if (shown && i > 0) { li.classList.remove('fresh'); void li.offsetWidth; li.classList.add('fresh'); }
    }
    li.style.display = !shown && lockedShown ? 'none' : '';
    if (!shown) lockedShown = true;
    if (!shown) { li.classList.remove('met'); li.querySelector('.ck').textContent = ''; li.querySelector('.gv').textContent = ''; return; }
    const fog = g.kpi && fogged(G, g.kpi);
    const met = !fog && goalMet(G, g, k);
    li.classList.toggle('met', met);
    li.querySelector('.ck').textContent = met ? '✓' : '';
    li.querySelector('.gv').textContent = fog ? '??' : goalShow(G, g, k);
  });
  if (L.steps) {
    const done = { identify: G.steps.identify, exploit: G.steps.exploit, subordinate: G.steps.subordinate, elevate: G.steps.elevate,
      repeat: G.steps.elevate && G.st[1].heroProb === 0 && G.st[2].heroProb === 0 && G.st[4].heroProb === 0 };
    document.querySelectorAll('.step').forEach(el => el.classList.toggle('done', !!done[el.dataset.step]));
  }

  if (G.mentorQ.length > UI.mentorShown) {
    UI.mentorShown = G.mentorQ.length;
    renderFeed(G);
  }
  updateWatchBadges(G);
  renderLog(G);
  updateTools();
  if (UI.selected != null) updateStationPanel();
  positionTour();
  updateTourTask();
  if (!$('#board').classList.contains('hidden')) renderBoard();
}

// ---------- guided tour (shift 0) ----------
function tourActive() { return !!(UI.G && UI.G.L.tour && !UI.G.tourDone && UI.G.tourStep != null); }
function renderTour() {
  const G = UI.G, i = G.tourStep, st = TOUR[i], el = $('#tour');
  UI.tourRect = st.rect || (st.station != null ? platformRect(G.st[st.station]) : null);
  document.body.classList.toggle('tour-hud', !!st.hud);
  el.classList.remove('hidden');
  el.innerHTML = `<div class="tour-k">Floor tour · ${i + 1} / ${TOUR.length}</div><h4>${st.title}</h4><p>${st.text}</p>
    <div class="tour-dots">${TOUR.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'done' : ''}"></i>`).join('')}</div>
    ${st.task ? `<div class="tour-task" data-task>${st.task.text}</div>` : ''}
    <div class="tour-actions">${i > 0 ? '<button class="btn" data-back>Back</button>' : ''}<button class="btn primary" data-next>${i === TOUR.length - 1 ? 'Finish tour' : 'Next →'}</button></div>`;
  el.querySelector('[data-next]').onclick = () => tourGo(1);
  const b = el.querySelector('[data-back]');
  if (b) b.onclick = () => tourGo(-1);
  tourPosKey = '';
  positionTour();
  updateHud();
}
// A tour step with a task only continues once the player has done it.
function tourTaskDone() {
  const st = TOUR[UI.G.tourStep];
  return !st.task || st.task.done(UI.G);
}
function updateTourTask() {
  if (!tourActive()) return;
  const done = tourTaskDone(), el = $('#tour');
  const nx = el.querySelector('[data-next]'), tk = el.querySelector('[data-task]');
  if (nx) nx.disabled = !done;
  if (tk) tk.classList.toggle('done', done);
}
function tourGo(d) {
  const G = UI.G;
  if (!tourActive()) return;
  if (d > 0 && !tourTaskDone()) return;
  const n = G.tourStep + d;
  if (n < 0) return;
  if (n >= TOUR.length) { G.tourDone = true; endTourUi(); G.ended = 'complete'; return; }
  G.tourStep = n;
  renderTour();
}
// Place the tour card as close as possible to the highlight without covering it.
let tourPosKey = '';
function hull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.reverse()) { while (up.length > 1 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function positionTour() {
  if (!tourActive()) return;
  const st = TOUR[UI.G.tourStep], el = $('#tour'), r = el.getBoundingClientRect();
  const key = [UI.G.tourStep, innerWidth, innerHeight, Math.round(r.height)].join(':');
  if (key === tourPosKey) return;
  tourPosKey = key;
  const minX = 336, maxX = innerWidth - 336 - r.width, minY = 96, maxY = innerHeight - 140 - r.height;
  let best = { left: innerWidth / 2 - r.width / 2, top: innerHeight / 2 - r.height / 2 - 40 };
  if (UI.tourRect && !st.hud) {
    const [x0, y0, x1, y1] = UI.tourRect, pad = 18;
    const pts = [];
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) for (const z of [0, 1.9]) pts.push(toScreen(x, y, z));
    const poly = hull(pts);
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let bestScore = Infinity;
    for (let left = minX; left <= Math.max(minX, maxX); left += 24) {
      for (let top = minY; top <= Math.max(minY, maxY); top += 24) {
        let hits = 0;
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 6; j++) {
          const x = left - pad + (r.width + 2 * pad) * i / 8, y = top - pad + (r.height + 2 * pad) * j / 6;
          if (inPoly(x, y, poly)) hits++;
        }
        const dist = Math.hypot(left + r.width / 2 - cx, top + r.height / 2 - cy);
        const score = hits * 1000 + dist;
        if (score < bestScore) { bestScore = score; best = { left, top }; }
      }
    }
  }
  el.style.left = clamp(best.left, minX, Math.max(minX, maxX)) + 'px';
  el.style.top = clamp(best.top, minY, Math.max(minY, maxY)) + 'px';
}
function endTourUi() {
  UI.tourRect = null;
  $('#tour').classList.add('hidden');
  $('#tour').innerHTML = '';
  document.body.classList.remove('tour-hud');
}

// ---------- mentor ----------
// Voices on the floor: the mentor only asks questions; the others push the instinctive fix.
const AV = (bg, shirt, extra) => `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${bg}"/>
  <path d="M7 40c1-8 6-12 13-12s12 4 13 12z" fill="${shirt}"/><circle cx="20" cy="17" r="7.5" fill="#f2c9a5"/>${extra}</svg>`;
const VOICES = {
  mentor: { name: 'The Mentor', tag: 'Question', role: '@mentor', av: AV('#8e7cc3', '#4b3f72',
    '<path d="M12.5 15c0-6 15-6 15 0-2-3-13-3-15 0z" fill="#d9d9e3"/><circle cx="17" cy="17.5" r="2.4" fill="none" stroke="#222" stroke-width="1.2"/><circle cx="23" cy="17.5" r="2.4" fill="none" stroke="#222" stroke-width="1.2"/><path d="M19.4 17.5h1.2" stroke="#222" stroke-width="1.2"/>') },
  boss: { name: 'The Board', tag: 'Pressure', role: '@board', av: AV('#e0614a', '#2b2f3a',
    '<path d="M12.5 15.5c0-7 15-7 15 0-3-4-12-4-15 0z" fill="#3a2a22"/><path d="M17 28l3 3 3-3z" fill="#fff"/><path d="M19 30.5h2l1 8h-4z" fill="#c22f3c"/>') },
  ops: { name: 'Ops Lead', tag: 'Alarm', role: '@ops', av: AV('#3fae78', '#22423a',
    '<path d="M12.5 15c0-6 15-6 15 0z" fill="#5a3a22"/><path d="M11 17a9 9 0 0 1 18 0" fill="none" stroke="#222" stroke-width="1.6"/><rect x="9.5" y="16" width="3" height="5" rx="1.2" fill="#222"/>') },
  sales: { name: 'Sales', tag: 'Request', role: '@sales', av: AV('#4ea3ff', '#1d3a63',
    '<path d="M12 16c0-8 16-8 16 0-2-2-5-3-8-3s-6 1-8 3z" fill="#c9852f"/><path d="M18 28h4l-2 4z" fill="#fff"/>') },
  security: { name: 'Security Chief', tag: 'Policy', role: '@security', av: AV('#3f8fd8', '#24344a',
    '<path d="M11.5 14.5c1-6 16-6 17 0z" fill="#1b2433"/><path d="M10 14.5h20v2H10z" fill="#1b2433"/><path d="M26 32l3 1v3c0 2-1.5 3-3 3.5-1.5-.5-3-1.5-3-3.5v-3z" fill="#ffd25a"/>') },
};
function postHtml(m, i) {
  const v = VOICES[m.who] || VOICES.mentor;
  return `<div class="post who-${m.who || 'mentor'}${i === 0 ? ' latest' : ' old'}">
    <div class="av">${v.av}</div>
    <div class="pb"><div class="ph"><b>${esc(v.name)}</b><span class="pt">day ${Math.max(0, m.t).toFixed(1)}</span></div>
    <div class="role"><span class="tag">${v.tag}</span>${esc(v.role)}</div><p>${esc(m.text)}</p></div></div>`;
}
// Dim the floor for a moment and put a spotlight on the speaker.
let spotTimer = 0;
function spotlight(el, who) {
  const fx = $('#focusFx'), r = el.getBoundingClientRect();
  if (UI.modal || !r.width) return;
  fx.style.setProperty('--fx', r.left + r.width / 2 + 'px');
  fx.style.setProperty('--fy', r.top + Math.min(r.height, 220) / 2 + 'px');
  fx.style.setProperty('--fr', Math.max(r.width, 200) * .75 + 'px');
  fx.dataset.who = who;
  fx.classList.remove('on'); void fx.offsetWidth; fx.classList.add('on');
  clearTimeout(spotTimer);
  spotTimer = setTimeout(() => fx.classList.remove('on'), who === 'mentor' ? 1600 : 2400);
}
function renderFeed(G) {
  const f = $('#feed');
  f.innerHTML = G.mentorQ.slice(-3).reverse().map(postHtml).join('');
  if (f.firstElementChild) f.firstElementChild.classList.add('pop', 'flash');
  // a new voice on the floor pulls focus: glow, flash, and a nudge when someone pushes a quick fix
  const panel = f.closest('.mentor'), who = (G.mentorQ[G.mentorQ.length - 1] || {}).who || 'mentor';
  panel.dataset.who = who;
  panel.classList.remove('ping', 'pressure'); void panel.offsetWidth;
  panel.classList.add('ping');
  if (who === 'boss' || who === 'security') panel.classList.add('pressure');
  clearTimeout(panel._pingT);
  panel._pingT = setTimeout(() => panel.classList.remove('ping', 'pressure'), 3400);
  spotlight(panel, who);
}
function nextHint() {
  const G = UI.G, h = G.L.hints || [];
  if (!h.length) return;
  mentorSay(G, 'Hint: ' + h[UI.hintI++ % h.length]);
  updateHud();
}

// ---------- station panel ----------
function openStation(i) {
  const G = UI.G;
  // in the fog, the only way to know what happens at a station is to walk over and ask
  if (G.L.fog && i > 0 && G.kanbanT == null && !G.ended) {
    G.peek[i] = { t0: G.t, until: G.t + 1.4 };
    G.peeked.add(i);
  }
  UI.selected = i;
  $('#stationPanel').classList.remove('hidden');
  updateStationPanel(true);
}
function closeStation() { UI.selected = null; $('#stationPanel').classList.add('hidden'); }

function updateStationPanel(rebuild) {
  const G = UI.G, s = G.st[UI.selected], el = $('#stationPanel');
  if (!s) return;
  const fog = stationFog(G, s.i) > .5 && s.i > 0, peek = peeking(G, s.i);
  const nW = s.workers.length;
  let html = `<div class="sp-head"><div><b>${esc(s.name)}</b><small>${s.i === 0 ? 'intake' : nW + (nW > 1 ? ' workers' : ' worker')}</small></div><button class="x-btn" data-close>×</button></div>`;
  if (s.i === 0) {
    html += `<div class="sp-row"><span>Waiting to be released</span><b>${G.backlog.length}</b></div>`;
    html += `<div class="sp-row"><span>Release rule</span><b>${G.flags.utilDrive ? 'push everything' : G.flags.freeze ? 'projects frozen' : G.flags.rope ? 'paced to constraint' : G.st[1].limit != null ? 'pull (Dev limit)' : 'push on arrival'}</b></div>`;
    html += `<div class="sp-row"><span>Hallway requests</span><b>${G.L.shadowRate ? (G.owned.singleIntake ? 'blocked' : 'bypassing intake') : '–'}</b></div>`;
    if (G.L.shadowRate && G.owned.kanban) G.seen.shadow = true;
  } else if (peek) {
    const here = G.crates.filter(c => c.loc === s.i && FLOOR_STATES.has(c.state) && c.type !== 'unp');
    const hall = here.filter(c => c.shadow).length, fires = G.crates.filter(c => c.loc === s.i && c.type === 'unp').length;
    const left = G.peek[s.i].until - G.t;
    html += `<p class="sp-note">You walked over and asked around.</p>`;
    html += `<div class="sp-row"><span>Items in progress here</span><b>${here.length}</b></div>`;
    html += `<div class="sp-row"><span>…of those, hallway requests</span><b>${hall}</b></div>`;
    html += `<div class="sp-row"><span>Fires being fought</span><b>${fires}</b></div>`;
    html += `<div class="peek-bar"><i style="width:${clamp(left / 1.4, 0, 1) * 100}%"></i></div><p class="sp-note small">Knowledge goes stale. When you look away, the fog comes back.</p>`;
  } else if (fog) {
    html += `<p class="sp-note">Nobody knows what's going on here anymore. Work arrives through hallways and chats, and there's no board.</p>
      <button class="btn small" data-ask>Ask around again</button>`;
  } else {
    if (s.q.some(c => c.shadow) || G.crates.some(c => c.loc === s.i && c.shadow && c.state === 'proc')) G.seen.shadow = true;
    const u = s.u, inProg = s.workers.filter(w => w.cur).length;
    const mult = u >= .99 ? '∞' : (u / (1 - u)).toFixed(1);
    html += `<div class="sp-row"><span>Utilization (busiest worker)</span><b>${Math.round(u * 100)}%</b></div>`;
    html += `<div class="sp-row"><span>Waiting · working · done-waiting</span><b>${s.q.length} · ${inProg} · ${s.out.length}</b></div>`;
    if (G.L.showHero && s.heroProb > 0) html += `<div class="sp-row"><span>Items needing the hero</span><b>${Math.round(s.heroProb * 100)}%</b></div>`;
    if (s.key === 'ops' && G.batch > 1) html += `<div class="sp-row"><span>Deploy batch size</span><b>${G.batch}</b></div>`;
    html += `<div class="sp-wait"><div class="f">Expected wait = busy ÷ idle</div><div class="big">≈ ${mult}× work time</div><canvas></canvas></div>`;
    if (G.owned.wipLimits) {
      html += `<div class="limit-ctl" style="margin-top:10px;font-size:12.5px">WIP limit <button data-lim="-1">−</button><b>${s.limit ?? '∞'}</b><button data-lim="1">+</button>
        <span style="margin-left:auto">in station: <b>${stationCount(G, s.i)}</b></span></div>`;
    }
  }
  // level-specific diagnosis: what you learn by looking closely at this station
  G.seen['st_' + s.key] = true;
  const insp = !fog && !peek && G.L.inspect && G.L.inspect[s.key] && G.L.inspect[s.key](G, s);
  if (insp) {
    html += `<div class="sp-insight"><div class="eyebrow">You notice</div>${insp.html}</div>`;
    if (insp.seen) G.seen[insp.seen] = true;
  }
  el.innerHTML = html;
  el.querySelector('[data-close]').onclick = closeStation;
  const ask = el.querySelector('[data-ask]');
  if (ask) ask.onclick = () => openStation(s.i);
  el.querySelectorAll('[data-lim]').forEach(b => b.onclick = () => { changeLimit(s, Number(b.dataset.lim)); updateStationPanel(); });
  const cvs = el.querySelector('canvas');
  if (cvs) waitCurve(cvs, s.u);
  // position next to the station
  const [sx, sy] = toScreen(s.x, 1.2, 2.2);
  const r = el.getBoundingClientRect();
  let left = sx + 70, top = sy - r.height / 2;
  if (left + r.width > innerWidth - 324) left = sx - r.width - 70;
  top = clamp(top, 80, innerHeight - r.height - 130);
  el.style.left = left + 'px'; el.style.top = top + 'px';
}

function changeLimit(s, d) {
  const cur = s.limit ?? 0;
  let v = cur + d;
  if (s.limit == null) v = d < 0 ? Math.max(1, stationCount(UI.G, s.i) - 1) : 2 * s.workers.length;
  s.limit = v <= 0 ? null : Math.min(30, v);
  const f = FEEDBACK.limits;
  logDecision(UI.G, { key: 'limits', kind: 'tool', merge: 'limit-' + s.i, label: `WIP limit · ${s.name} → ${s.limit ?? '∞'}`,
    trap: false, why: f.works, expect: s.limit == null ? {} : f.expect, delay: f.delay, station: s.i });
}

function waitCurve(c, u) {
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.body);
  const muted = css.getPropertyValue('--muted').trim(), acc = css.getPropertyValue('--accent').trim();
  const maxY = 20, X = v => 4 + v * (w - 8), Y = v => h - 12 - Math.min(v, maxY) / maxY * (h - 18);
  g.strokeStyle = muted; g.globalAlpha = .35; g.lineWidth = 1;
  g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(0)); g.stroke();
  g.globalAlpha = 1;
  g.beginPath();
  for (let i = 0; i <= 100; i++) { const x = i / 100 * .97, v = x / (1 - x); i ? g.lineTo(X(x), Y(v)) : g.moveTo(X(x), Y(v)); }
  g.strokeStyle = muted; g.lineWidth = 1.5; g.stroke();
  const uu = Math.min(u, .97), vv = uu / (1 - uu);
  g.fillStyle = acc;
  g.beginPath(); g.arc(X(uu), Y(vv), 4.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = muted; g.font = '10px Inter, system-ui, sans-serif';
  g.textAlign = 'left'; g.fillText('0%', X(0), h - 1);
  g.textAlign = 'right'; g.fillText('utilization 100%', X(1), h - 1);
}

// ---------- board ----------
function toggleBoard() {
  const b = $('#board');
  b.classList.toggle('hidden');
  if (!b.classList.contains('hidden')) renderBoard();
  updateHud();
}
function renderBoard() {
  const G = UI.G, b = $('#board');
  if (G.L.fog && !G.owned.kanban) {
    b.innerHTML = '<h3>Kanban board</h3><p style="margin:0;color:var(--muted)">There is no board yet. Buy the Kanban board in the toolbox to see all work in one place.</p>';
    return;
  }
  G.seen.board = true;
  if (G.crates.some(c => c.shadow && c.loc >= 1 && c.loc <= 4)) G.seen.shadow = true;
  const chip = c => typeIcon(c.type, 'chipc' + (c.shadow ? ' hidden-work' : ''));
  const chips = list => list.slice(0, 40).map(chip).join('') + (list.length > 40 ? `<span class="more">+${list.length - 40}</span>` : '');
  const cols = [{ name: 'Backlog', list: G.backlog, s: null }];
  for (let i = 1; i <= 4; i++) cols.push({ name: G.st[i].name, list: G.crates.filter(c => c.loc === i), s: G.st[i] });
  const done = G.stats.delivered.filter(d => d.t > G.t - 1);
  let html = '<div class="board-cols">';
  for (const col of cols) {
    const n = col.s ? stationCount(G, col.s.i) : col.list.length;
    const over = col.s && col.s.limit != null && n > col.s.limit;
    html += `<div class="col"><div class="col-h"><span>${esc(col.name)}</span><span class="cnt${over ? ' over' : ''}">${n}${col.s && col.s.limit != null ? ' / ' + col.s.limit : ''}</span></div><div class="chips">${chips(col.list)}</div>`;
    if (col.s && G.owned.wipLimits) html += `<div class="limit-ctl">limit <button data-bl="${col.s.i}" data-d="-1">−</button><b>${col.s.limit ?? '∞'}</b><button data-bl="${col.s.i}" data-d="1">+</button></div>`;
    html += '</div>';
  }
  html += `<div class="col"><div class="col-h"><span>Done today</span><span class="cnt">${done.length}</span></div><div class="chips">${done.slice(-40).map(d => typeIcon(d.type, 'chipc')).join('')}</div></div>`;
  html += '</div><div class="legend">' + Object.keys(TYPE_INFO).map(t => `<span>${typeIcon(t, 'chipc')}${TYPE_INFO[t].name}</span>`).join('') + (G.L.shadowRate ? `<span>${typeIcon('biz', 'chipc hidden-work')}Hallway request</span>` : '') + '</div>';
  b.innerHTML = html;
  b.querySelectorAll('[data-bl]').forEach(btn => btn.onclick = () => { changeLimit(G.st[Number(btn.dataset.bl)], Number(btn.dataset.d)); renderBoard(); });
}

// ---------- modals ----------
function openModal(html, wide) {
  UI.modal = true;
  $('#callout').classList.add('hidden');
  $('#banner').classList.add('hidden');
  const card = $('#modalCard');
  card.className = 'modal-card panel' + (wide ? ' wide' : '');
  card.innerHTML = html;
  $('#modal').classList.remove('hidden');
  card.scrollTop = 0;
  return card;
}
function closeModal() { UI.modal = false; $('#modal').classList.add('hidden'); }

// The level brief is optional now: the floor shows the problem, this only recaps it.
function showBrief() {
  const G = UI.G, L = G.L;
  const card = openModal(`
    <div class="eyebrow">Shift ${L.id} · ${esc(L.concept)}</div>
    <h2>${esc(L.title)}</h2>
    <p>${esc(L.hook)}</p>
    <div class="section-h">Shift goals (${L.days} days)</div>
    <ul>${L.goals.map(g => `<li>${esc(!g.reveal || g.reveal(G) ? g.label : 'Hidden until you find the problem')}</li>`).join('')}</ul>
    <p class="muted" style="font-size:12.5px">Click stations to inspect them. Not every tool helps, and some are traps.
    <span class="kbd">Space</span> pause · <span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span> speed · <span class="kbd">B</span> board</p>
    <div class="modal-actions"><button class="btn primary" data-go>Back to the floor</button></div>`);
  card.querySelector('[data-go]').onclick = () => { closeModal(); updateHud(); };
}

function showEvent(ev) {
  const G = UI.G;
  const card = openModal(`
    <div class="eyebrow">Day ${Math.floor(G.t)} · Decision</div>
    <h2>${esc(ev.title)}</h2>
    <p>${esc(ev.body)}</p>
    ${ev.options.map((o, i) => `<button class="opt" data-o="${i}"><b>${esc(o.label)}</b><small>${esc(o.desc || '')}</small></button>`).join('')}`);
  card.querySelectorAll('[data-o]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.o), o = ev.options[i];
    G.choices[ev.idx] = i;
    const dec = { key: 'event', kind: 'event', label: `${ev.title}: ${o.label}`, trap: !!o.trap, why: o.trap || o.why,
      expect: o.expect || {}, delay: 2, station: null, fixed: o.trap ? null : 'helped',
      afterText: o.trap ? `Remember "${ev.title}"? Did that decision really help?` : null };
    o.apply(G);
    logDecision(G, dec);
    closeModal(); updateHud();
  });
}

function showClassify(item, idx) {
  const G = UI.G;
  const card = openModal(`
    <div class="eyebrow">Request ${idx + 1} of ${G.L.items.length}</div>
    <h2>What type of work is this?</h2>
    ${item.from ? `<div class="feed req">${postHtml({ who: item.from, text: item.text, t: G.t }, 0)}</div>` : `<div class="quote">"${esc(item.text)}"</div>`}
    <div class="types">${Object.keys(TYPE_INFO).map(t => `<button class="opt" data-t="${t}">${typeIcon(t, 'sw')}<span><b>${TYPE_INFO[t].name}</b><small>${TYPE_INFO[t].desc}</small></span></button>`).join('')}</div>
    <div id="fb"></div>`);
  card.querySelectorAll('[data-t]').forEach(b => b.onclick = () => {
    const type = b.dataset.t, ok = tutorialAnswer(G, type);
    card.querySelectorAll('[data-t]').forEach(x => {
      x.disabled = true;
      if (x.dataset.t === item.type) x.classList.add('right');
      else if (x.dataset.t === type) x.classList.add('wrong');
    });
    card.querySelector('#fb').innerHTML = `<div class="feedback ${ok ? 'ok' : 'no'}"><b>${ok ? 'Correct.' : 'Not quite. It\'s a ' + TYPE_INFO[item.type].name.toLowerCase() + '.'}</b> ${esc(item.why)}</div>
      <div class="modal-actions"><button class="btn primary" data-c>Continue</button></div>`;
    card.querySelector('[data-c]').onclick = () => { closeModal(); updateHud(); };
  });
}

function evaluate(G) {
  const k = computeKpis(G);
  const res = G.L.goals.map(g => ({ label: g.label, met: G.ended === 'complete' && goalMet(G, g, k), val: goalShow(G, g, k) }));
  let stars = 0;
  if (G.ended === 'complete') {
    if (G.L.stars) stars = G.L.stars(G);
    else {
      const m = res.filter(r => r.met).length;
      stars = m === res.length ? 3 : m >= Math.ceil(res.length / 2) ? 2 : 1;
    }
  }
  return { res, stars };
}

function insightHtml(L, locked) {
  if (locked) return `<div class="insight locked"><div class="eyebrow">Shift ${L.id}</div><h4>Locked</h4><p class="muted">Finish "${esc(L.title)}" to unlock this card.</p></div>`;
  return `<div class="insight"><div class="eyebrow">Insight · Shift ${L.id}</div><h4>${esc(L.insight.title)}</h4><p>${esc(L.insight.body)}</p><span class="formula">${esc(L.insight.formula)}</span></div>`;
}

function showDebrief() {
  const G = UI.G, L = G.L, { res, stars } = evaluate(G);
  const ok = G.ended === 'complete';
  if (ok) {
    UI.save.stars = UI.save.stars || {};
    UI.save.stars[L.id] = Math.max(UI.save.stars[L.id] || 0, stars);
    persist();
  }
  const H = UI.ghost;
  const hasNext = L.id + 1 < LEVELS.length;
  const decs = L.tutorial || L.tour ? '' : debriefDecisionsHtml(G);
  const missed = debriefMissedHtml(G), nMissed = (L.missed || []).filter(m => !m.done(G)).length;
  const card = openModal(`
    <div class="eyebrow">Shift ${L.id} · ${esc(L.title)}</div>
    <h2>${ok ? 'Shift complete' : 'The business lost patience'}</h2>
    ${ok ? `<div class="big-stars">${starHtml(stars)}</div>` : `<p>Too many late deliveries and open incidents on day ${G.t.toFixed(1)}. Try again: the list below shows what to change.</p>`}
    ${debriefScoreHtml(G, H, res)}
    ${!ok && missed ? `<div class="try-next"><div class="eyebrow">Try next time</div>${missed}</div>` : ''}
    ${ok ? `<div class="reflect-card">
      <div class="eyebrow">Your turn · reflect</div>
      <h3>${esc(L.reflection.q)}</h3>
      <div id="refl">${L.reflection.options.map((o, i) => `<button class="opt" data-r="${i}"><b style="font-weight:600">${esc(o)}</b></button>`).join('')}</div>
      <div id="reflOut"><p class="muted small-note">Answer to unlock your insight card${hasNext ? ' and the next shift' : ''}.</p></div>
    </div>` : ''}
    <div class="db-more">
      ${H ? `<details data-charts><summary>Charts: you vs. the untouched factory</summary>${debriefCompareHtml(G, H)}</details>` : ''}
      ${decs ? `<details><summary>Your decisions ${decisionSummary(G)}</summary>${decs}</details>` : ''}
      ${ok && missed ? `<details><summary>Missed opportunities ${nMissed ? `<span class="sc-chip bad">${nMissed}</span>` : '<span class="sc-chip good">none</span>'}</summary>${missed}</details>` : ''}
    </div>
    <div class="modal-actions">
      <button class="btn" data-menu>Menu</button>
      <button class="btn${ok ? '' : ' primary'}" data-retry>Retry shift</button>
      ${ok && hasNext ? `<button class="btn primary" data-next disabled>Next shift →</button>` : ''}
      ${ok && !hasNext ? `<button class="btn primary" data-deck disabled>See your insight deck</button>` : ''}
    </div>`, !!H);
  const ch = card.querySelector('[data-charts]');
  if (ch) ch.addEventListener('toggle', () => { if (ch.open) card.querySelectorAll('[data-cmp]').forEach(c => compareChart(c, G, H, c.dataset.cmp)); });
  card.querySelector('[data-menu]').onclick = showTitle;
  card.querySelector('[data-retry]').onclick = () => startLevel(L.id);
  const next = card.querySelector('[data-next]'), deck = card.querySelector('[data-deck]');
  if (next) next.onclick = () => startLevel(L.id + 1);
  if (deck) deck.onclick = showDeck;
  card.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.r), right = i === L.reflection.correct;
    card.querySelectorAll('[data-r]').forEach(x => {
      x.disabled = true;
      if (Number(x.dataset.r) === L.reflection.correct) x.classList.add('right');
      else if (x === b) x.classList.add('wrong');
    });
    card.querySelector('#reflOut').innerHTML = `<div class="feedback ${right ? 'ok' : 'no'}" style="margin-bottom:14px"><b>${right ? 'Exactly.' : 'Not quite.'}</b> ${esc(L.reflection.explain)}</div>${insightHtml(L)}`;
    if (next) { next.disabled = false; next.classList.add('ready'); }
    if (deck) { deck.disabled = false; deck.classList.add('ready'); }
    card.querySelector('.reflect-card').classList.add('answered');
    card.querySelector('#reflOut').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function showDeck() {
  const card = openModal(`
    <div class="eyebrow">Your cheat sheet</div>
    <h2>Insight deck</h2>
    <p class="muted">One card per completed shift: the lessons of The Phoenix Project in your pocket.</p>
    <div class="deck">${LEVELS.map(L => insightHtml(L, !((UI.save.stars || {})[L.id] >= 1))).join('')}</div>
    <div class="modal-actions"><button class="btn primary" data-close>Close</button></div>`, true);
  card.querySelector('[data-close]').onclick = () => { closeModal(); if (UI.screen !== 'title') showTitle(); };
}

function confirmExit() {
  const prev = UI.G.speed;
  const card = openModal(`<h2>Leave this shift?</h2><p class="muted">Progress in this shift will be lost.</p>
    <div class="modal-actions"><button class="btn" data-stay>Stay</button><button class="btn primary" data-leave>Back to menu</button></div>`);
  card.querySelector('[data-stay]').onclick = () => { closeModal(); UI.G.speed = prev; };
  card.querySelector('[data-leave]').onclick = showTitle;
}

// ---------- tooltips ----------
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]'), tip = $('#tip');
  if (!t) { tip.classList.add('hidden'); return; }
  tip.innerHTML = t.dataset.tip;
  tip.classList.remove('hidden');
  const r = t.getBoundingClientRect(), tr = tip.getBoundingClientRect();
  let top = r.top - tr.height - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = clamp(r.left + r.width / 2 - tr.width / 2, 8, innerWidth - tr.width - 8) + 'px';
  tip.style.top = top + 'px';
});
