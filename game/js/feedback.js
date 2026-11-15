'use strict';
// Decision feedback loop: log → expectation → effect check → debrief.
// Also the business-patience meter and the "you vs. untouched factory" charts.

const VERDICT = {
  helped: { label: 'Helped', cls: 'good' },
  hurt: { label: 'Made it worse', cls: 'bad' },
  neutral: { label: 'No clear effect', cls: 'neutral' },
  trap: { label: 'Trap', cls: 'bad' },
  wrong: { label: 'Wrong guess', cls: 'bad' },
  info: { label: 'Done', cls: 'neutral' },
  pending: { label: 'Watching…', cls: 'pending' },
  early: { label: 'Too early to tell', cls: 'neutral' },
};
// How much a KPI must move to count as a real change.
const KPI_SCALE = { lead: .5, thr: .3, wip: 3, unp: 6, debt: 4, cfr: 4, deploys: .4, mttr: .15, patience: 5 };
const PATIENCE_META = { label: 'Business patience', unit: '', fmt: v => String(Math.round(v)), color: 'chg' };
function kmeta(k) { return k === 'patience' ? PATIENCE_META : KPI_META[k]; }

// KPI levels averaged over the last day, so a single noisy sample can't decide a verdict.
function snapshot(G) {
  const now = Object.assign({ patience: G.patience }, computeKpis(G)), out = {};
  for (const k of Object.keys(now)) {
    const s = G.series[k] || [], vals = [];
    for (let i = s.length - 1; i >= 0 && G.t - G.seriesT[i] <= 1; i--) if (s[i] != null) vals.push(s[i]);
    if (now[k] != null) vals.push(now[k]);
    out[k] = vals.length ? avg(vals) : null;
  }
  return out;
}
function stationIdx(G, key) { const s = G.st.find(x => x.key === key); return s ? s.i : null; }

function toolDecision(G, key, s, extra) {
  const t = TOOLS[key], f = FEEDBACK[key] || {};
  const trap = typeof t.trap === 'function' ? t.trap(G, s) : !!t.trap;
  const why = trap ? (typeof t.why === 'function' ? t.why(G, s) : t.why) : f.works;
  return Object.assign({
    key, kind: 'tool', label: t.name + (s ? ` · ${s.name}` : ''), trap, why,
    expect: f.expect || {}, delay: f.delay ?? 2, station: s ? s.i : stationIdx(G, f.focus),
    watch: f.watch, afterText: t.after, fixed: f.fixed, lag: f.lag,
  }, extra);
}

// Logs a decision. `merge` folds rapid repeats (slider drags, limit clicks) into one entry.
function logDecision(G, d) {
  const last = G.decisions[G.decisions.length - 1];
  if (d.merge && last && last.merge === d.merge && !last.verdict && G.t - last.t < .5) {
    Object.assign(last, { label: d.label, expect: d.expect, why: d.why, station: d.station });
    return last;
  }
  const dec = Object.assign({ t: G.t, before: snapshot(G), after: null, verdict: null, measured: null, lines: [] }, d);
  G.decisions.push(dec);
  if (dec.station != null) G.pulses.push({ i: dec.station, t0: G.t });
  if (dec.fixed) { dec.verdict = dec.measured = dec.fixed; dec.checkedAt = G.t; }
  else if (Object.keys(dec.expect).length) G.schedule.push({ at: G.t + dec.delay, fn: g => checkDecision(g, dec) });
  else { dec.verdict = dec.measured = 'info'; dec.checkedAt = G.t; }
  if (dec.trap && dec.verdict) dec.verdict = 'trap';
  dec.id = G.decisions.length;
  return dec;
}

function measure(dec, after) {
  const lines = [];
  let score = 0;
  for (const [k, dir] of Object.entries(dec.expect || {})) {
    const b = dec.before[k], a = after[k];
    if (a == null || b == null) continue;
    const delta = a - b;
    const res = Math.abs(delta) < (KPI_SCALE[k] ?? 1) ? 0 : Math.sign(delta) === dir ? 1 : -1;
    score += res;
    lines.push({ k, b, a, dir, res });
  }
  // patience as context: the business sees the result of every decision
  if (!('patience' in (dec.expect || {})) && dec.before.patience != null) {
    const b = dec.before.patience, a = after.patience, d = a - b;
    lines.push({ k: 'patience', b, a, dir: 1, res: Math.abs(d) < KPI_SCALE.patience ? 0 : Math.sign(d), context: true });
  }
  return { lines, score };
}

function checkDecision(G, dec, silent) {
  if (dec.verdict) return;
  dec.after = snapshot(G);
  dec.checkedAt = G.t;
  const { lines, score } = measure(dec, dec.after);
  dec.lines = lines;
  dec.measured = !lines.some(l => !l.context) ? 'neutral' : score > 0 ? 'helped' : score < 0 ? 'hurt' : 'neutral';
  dec.verdict = dec.trap ? 'trap' : dec.measured;
  if (silent) return;
  const body = lines.length ? lineText(lines) : 'nothing moved yet';
  let end = { helped: dec.trap ? 'Looks like it\'s working… for now.' : 'It\'s working.', hurt: 'That made things worse.', neutral: 'No clear effect so far.' }[dec.measured];
  if (dec.measured !== 'helped' && dec.lag) end += ' ' + dec.lag;
  mentorSay(G, `Effect check on "${dec.label}" (day ${dec.t.toFixed(1)}): ${body}. ${end}${dec.trap && dec.afterText ? ' ' + dec.afterText : ''}`);
}

function lineText(lines, html) {
  return lines.map(l => {
    const m = kmeta(l.k), mark = l.context ? '' : l.res > 0 ? ' ✓' : l.res < 0 ? ' ✗' : ' ·';
    const s = `${m.label} ${m.fmt(l.b)} → ${m.fmt(l.a)}`;
    const cls = l.context ? 'ctx' : l.res > 0 ? 'good' : l.res < 0 ? 'bad' : '';
    return html ? `<span class="ln ${cls}">${esc(s)}${mark}</span>` : `${s}${mark}`;
  }).join(html ? '' : ', ');
}
function expectText(expect) {
  return Object.entries(expect || {}).map(([k, d]) => `${kmeta(k).label} ${d > 0 ? '↑' : '↓'}`).join(' · ');
}

// ---------- decision log (right column, chat style) ----------
// Your decision is a message; its effect check arrives later as a reply.
// In game the reply shows the measured effect; traps are only revealed in the debrief.
// Messages are shown when new and fade out after LOG_SHOW_MS; hovering the panel shows the whole history.
const seenLog = new Map(), LOG_SHOW_MS = 7000;
function renderLog(G) {
  const box = $('#log');
  const sig = G.decisions.map(d => d.label + (d.measured || '')).join('|');
  if (box.dataset.sig === sig) return markRecent(box);
  box.dataset.sig = sig;
  if (!G.decisions.length) {
    box.innerHTML = '<p class="log-empty">Every tool you buy, toggle or slide shows up here. A day or two later the factory answers with an effect check: did it do what you expected?</p>';
    return;
  }
  const items = [];
  for (const d of G.decisions) {
    items.push({ t: d.t, o: 0, d, kind: 'you' });
    if (d.measured && d.measured !== 'info') items.push({ t: d.checkedAt ?? d.t, o: 1, d, kind: 'check' });
  }
  items.sort((a, b) => a.t - b.t || a.o - b.o);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = items.map(it => {
    const d = it.d, key = `${G.seed}:${d.id}:${it.kind}:${d.measured || ''}`;
    const fresh = !seenLog.has(key);
    if (fresh) seenLog.set(key, performance.now());
    if (it.kind === 'you') {
      const pending = !d.measured;
      return `<div class="msg you${fresh ? ' fresh' : ''}" data-k="${key}"><div class="msg-h">You · day ${d.t.toFixed(1)}</div>
        <b>${esc(d.label)}</b>${pending ? `<div class="t-watch">Watch: ${esc(expectText(d.expect))}<span class="t-when"> · check on day ${(d.t + d.delay).toFixed(1)}</span></div><div class="typing"><i></i><i></i><i></i></div>` : ''}</div>`;
    }
    const v = VERDICT[d.measured];
    return `<div class="msg check ${v.cls}${fresh ? ' fresh' : ''}" data-k="${key}"><div class="msg-h">Effect check · day ${(d.checkedAt ?? d.t).toFixed(1)}</div>
      <div class="re">re: ${esc(d.label)}</div><span class="vchip ${v.cls}">${v.label}</span>
      ${d.lines.length ? `<div class="t-lines">${lineText(d.lines, true)}</div>` : ''}</div>`;
  }).join('');
  if (atBottom || box.dataset.first !== '1' || !box.matches(':hover')) { box.scrollTop = box.scrollHeight; box.dataset.first = '1'; }
  markRecent(box);
}
function markRecent(box) {
  const now = performance.now();
  box.querySelectorAll('.msg').forEach(el => el.classList.toggle('recent', now - (seenLog.get(el.dataset.k) ?? 0) < LOG_SHOW_MS));
}

// ---------- KPI watch badges + sparkline markers ----------
function updateWatchBadges(G) {
  for (const key of G.L.kpis) {
    const el = $('#kw-' + key);
    if (!el) continue;
    const pend = G.decisions.filter(d => !d.verdict && d.expect && d.expect[key] != null);
    if (pend.length) {
      el.className = 'watch pending';
      el.textContent = `watching ${pend[pend.length - 1].expect[key] > 0 ? '↑' : '↓'}`;
      continue;
    }
    const recent = G.decisions.filter(d => d.checkedAt != null && G.t - d.checkedAt < 1.5)
      .flatMap(d => d.lines.filter(l => l.k === key));
    const l = recent[recent.length - 1];
    if (l) {
      el.className = 'watch ' + (l.res > 0 ? 'good' : l.res < 0 ? 'bad' : 'neutral');
      el.textContent = l.res > 0 ? '✓ improved' : l.res < 0 ? '✗ worse' : '· no change';
    } else { el.className = 'watch'; el.textContent = ''; }
  }
}

function markerColor(d) {
  const v = d.measured || 'pending';
  return v === 'helped' ? PAL.good : v === 'hurt' || v === 'wrong' ? PAL.bad : v === 'pending' ? PAL.select : PAL.gray;
}
function sparkline(c, ts, data, col, days, decisions) {
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  c._marks = [];
  const X = t => clamp(t / days, 0, 1) * (w - 4) + 2;
  for (const d of decisions || []) {
    const x = X(d.t);
    g.strokeStyle = markerColor(d); g.globalAlpha = .8; g.lineWidth = 1.5;
    g.setLineDash([2, 2]);
    g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h); g.stroke();
    g.setLineDash([]);
    g.fillStyle = markerColor(d);
    g.beginPath(); g.arc(x, 3.5, 3, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    c._marks.push({ x, d });
  }
  if (!data || data.length < 2) return;
  const vals = data.filter(v => v != null);
  const mx = Math.max(...vals, 1e-6) * 1.15;
  const Y = v => h - v / mx * (h - 8) - 1;
  g.beginPath();
  let started = false, lastX = 0;
  data.forEach((v, i) => {
    if (v == null) return;
    const x = X(ts[i]), y = Y(v);
    started ? g.lineTo(x, y) : g.moveTo(x, y);
    started = true; lastX = x;
  });
  g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  g.lineTo(lastX, h); g.lineTo(X(ts[data.findIndex(v => v != null)]), h); g.closePath();
  g.globalAlpha = .13; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
}
function decisionTip(d) {
  const v = VERDICT[d.measured || 'pending'];
  return `<b>Day ${d.t.toFixed(1)} · ${esc(d.label)}</b><br><span class="vchip ${v.cls}">${v.label}</span>` +
    (d.lines.length ? `<div class="t-lines">${lineText(d.lines, true)}</div>` : (d.verdict ? '' : `<div>Watch: ${esc(expectText(d.expect))}</div>`));
}
function attachMarkerHover(c) {
  c.addEventListener('mousemove', e => {
    const r = c.getBoundingClientRect(), mx = e.clientX - r.left;
    const m = (c._marks || []).find(k => Math.abs(k.x - mx) < 6);
    if (m) showTipAt(decisionTip(m.d), e.clientX, r.top);
    else hideTip();
  });
  c.addEventListener('mouseleave', hideTip);
}
function showTipAt(html, x, y) {
  const tip = $('#tip');
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const tr = tip.getBoundingClientRect();
  tip.style.left = clamp(x - tr.width / 2, 8, innerWidth - tr.width - 8) + 'px';
  tip.style.top = Math.max(8, y - tr.height - 10) + 'px';
}
function hideTip() { $('#tip').classList.add('hidden'); }

// ---------- business patience ----------
function patienceTrend(G) {
  const s = G.series.patience, ts = G.seriesT;
  if (!s || s.length < 3) return 0;
  const n = s.length - 1;
  let j = n;
  while (j > 0 && ts[n] - ts[j] < 1) j--;
  const dt = ts[n] - ts[j];
  return dt > 0 ? (s[n] - s[j]) / dt : 0;
}
function updatePatience(G) {
  const p = G.patience, L = G.L;
  $('#tbPat').textContent = Math.round(p);
  const bar = $('#tbPatBar');
  bar.style.width = p + '%';
  bar.className = p > 50 ? 'good' : p > 25 ? 'warn' : 'bad';
  const block = $('#patBlock');
  block.classList.toggle('low', p <= 25);
  const slope = patienceTrend(G), left = L.days - G.t, sub = $('#patSub');
  if (slope < -.8) {
    const runout = p / -slope;
    const danger = runout < left;
    sub.className = 'pat-sub ' + (danger ? 'danger' : 'warn');
    sub.textContent = `▼ ${(-slope).toFixed(1)}/day · empty in ~${runout.toFixed(1)} days${danger ? ' (before the shift ends!)' : ''}`;
  } else if (slope > .8) {
    sub.className = 'pat-sub good';
    sub.textContent = `▲ +${slope.toFixed(1)}/day · business is happy`;
  } else {
    sub.className = 'pat-sub';
    sub.textContent = `steady · ${left.toFixed(1)} days left in shift`;
  }
  // why it moves
  const parts = [];
  if (G.patDrain.incidents > 0) parts.push(`open incidents −${G.patDrain.incidents.toFixed(0)}/day`);
  if (G.patDrain.backlog > 0) parts.push(`huge backlog −${G.patDrain.backlog.toFixed(1)}/day`);
  if (G.patDrain.wip > 0) parts.push(`too much in progress −${G.patDrain.wip.toFixed(1)}/day`);
  const agg = {};
  for (const e of G.patLog) { const a = agg[e.reason] = agg[e.reason] || { n: 0, d: 0 }; a.n++; a.d += e.d; }
  const recent = Object.entries(agg).map(([r, a]) => `${a.d > 0 ? '+' : ''}${a.d.toFixed(1)} from ${a.n} ${r}${a.n > 1 && !r.endsWith('decision') ? 's' : ''}`);
  block.dataset.tip = `<b>Business patience</b>: your session limit. If it hits 0, the shift fails.<br>` +
    `Rises with on-time deliveries; drains with late work, failed deploys, open incidents, a huge backlog and a crowded floor.` +
    (parts.length ? `<br><br><b>Draining right now:</b> ${parts.join(', ')}` : '') +
    (recent.length ? `<br><b>Last day:</b> ${recent.join(', ')}` : '');
  // floating deltas
  if (G.patFx.length) {
    const agg2 = {};
    for (const e of G.patFx) { const a = agg2[e.reason] = agg2[e.reason] || { n: 0, d: 0 }; a.n++; a.d += e.d; }
    G.patFx.length = 0;
    const box = $('#patFx');
    for (const [r, a] of Object.entries(agg2)) {
      const el = document.createElement('span');
      el.className = 'pfx ' + (a.d >= 0 ? 'up' : 'down');
      el.textContent = `${a.d > 0 ? '+' : ''}${a.d.toFixed(1)} ${r}`;
      box.appendChild(el);
      setTimeout(() => el.remove(), 2200);
    }
    while (box.children.length > 4) box.firstChild.remove();
  }
  const vig = $('#vignette');
  vig.style.opacity = p < 40 ? ((40 - p) / 40).toFixed(2) : 0;
  vig.classList.toggle('pulse', p < 20);
}

// ---------- debrief: you vs. untouched factory ----------
function lastVal(arr) { for (let i = (arr || []).length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }
function compareChart(c, G, H, key) {
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.body);
  const muted = css.getPropertyValue('--muted').trim(), accent = css.getPropertyValue('--accent').trim();
  const m = kmeta(key), col = PAL.crate[m.color] || accent;
  const days = G.L.days, padL = 4, padB = 16, padT = 8;
  const all = [...(G.series[key] || []), ...(H.series[key] || [])].filter(v => v != null);
  const goal = G.L.goals.find(x => x.kpi === key);
  let mx = Math.max(...all, goal ? goal.val : 0, 1e-6) * 1.12;
  if (key === 'patience') mx = 100;
  const X = t => padL + clamp(t / days, 0, 1) * (w - padL * 2), Y = v => padT + (1 - v / mx) * (h - padT - padB);
  g.font = '10px Inter, system-ui, sans-serif'; g.fillStyle = muted; g.textAlign = 'center';
  g.strokeStyle = muted; g.globalAlpha = .25; g.lineWidth = 1;
  g.beginPath(); g.moveTo(padL, Y(0)); g.lineTo(w - padL, Y(0)); g.stroke();
  g.globalAlpha = .8;
  for (let d = 0; d <= days; d += 2) g.fillText('d' + d, clamp(X(d), 10, w - 10), h - 3);
  g.globalAlpha = 1;
  if (goal) {
    g.strokeStyle = accent; g.setLineDash([3, 4]); g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(padL, Y(goal.val)); g.lineTo(w - padL, Y(goal.val)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = accent; g.textAlign = 'right'; g.fillText('goal', w - padL - 2, Y(goal.val) - 3);
  }
  for (const d of G.decisions) {
    const x = X(d.t);
    g.strokeStyle = markerColor(d); g.globalAlpha = .55; g.setLineDash([2, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, padT); g.lineTo(x, Y(0)); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    g.fillStyle = markerColor(d); g.beginPath(); g.arc(x, padT, 3, 0, Math.PI * 2); g.fill();
  }
  const line = (S, ts, color, width, dash) => {
    g.beginPath(); let st = false;
    (S || []).forEach((v, i) => { if (v == null) return; const x = X(ts[i]), y = Y(v); st ? g.lineTo(x, y) : g.moveTo(x, y); st = true; });
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash || []); g.lineJoin = 'round'; g.stroke(); g.setLineDash([]);
  };
  line(H.series[key], H.seriesT, muted, 1.6, [5, 4]);
  line(G.series[key], G.seriesT, col, 2.6);
}

function debriefCompareHtml(G, H) {
  const keys = [...G.L.kpis, 'patience'];
  const ghostNote = H.ended === 'failed' ? ` The untouched factory lost the business on day ${H.t.toFixed(1)}.` : '';
  return `<div class="section-h">You vs. the untouched factory</div>
    <p class="muted" style="font-size:13px">Same shift, same random events, same event choices, but no toolbox actions. <span class="leg you"></span>you <span class="leg ghost"></span>untouched <span class="leg mk"></span>your decisions.${ghostNote}</p>
    <div class="cmp-grid">${keys.map(k => {
      const m = kmeta(k), you = lastVal(G.series[k]), gh = lastVal(H.series[k]);
      const f = v => v == null ? '–' : m.fmt(v);
      return `<div class="cmp"><div class="cmp-h"><b>${esc(m.label)}</b><span>you <b>${f(you)}</b> · untouched <b>${f(gh)}</b></span></div><canvas data-cmp="${k}"></canvas></div>`;
    }).join('')}</div>`;
}

function debriefDecisionsHtml(G) {
  for (const d of G.decisions) if (!d.verdict) {
    checkDecision(G, d, true);
    if (G.t - d.t < d.delay * .6) { d.verdict = d.measured = 'early'; d.lag = 'The shift ended before its effect could show.'; }
  }
  const list = G.decisions;
  const rows = list.map(d => {
    const v = VERDICT[d.verdict];
    const measuredNote = d.verdict === 'trap' && d.lines.some(l => !l.context) ? `<div class="m-note">Measured: ${VERDICT[d.measured].label.toLowerCase()}</div>` : '';
    return `<div class="dec ${v.cls}"><span class="day">day ${d.t.toFixed(1)}</span><div class="dec-b">
      <div class="dec-h"><b>${esc(d.label)}</b><span class="vchip ${v.cls}">${v.label}</span></div>
      ${d.lines.length ? `<div class="t-lines">${lineText(d.lines, true)}</div>` : ''}${measuredNote}
      ${d.why ? `<div class="why">${esc(d.why)}</div>` : ''}
      ${d.lag && !d.trap && d.measured !== 'helped' ? `<div class="why"><b>Why it didn't show yet:</b> ${esc(d.lag)}</div>` : ''}</div></div>`;
  }).join('');
  return `<div class="section-h">Your decisions</div>` + (list.length ? `<div class="timeline">${rows}</div>`
    : `<p class="muted">You made no decisions this shift.${G.L.tools.length ? ' The comparison above shows exactly what doing nothing looks like.' : ''}</p>`);
}

function debriefMissedHtml(G) {
  const missed = (G.L.missed || []).filter(m => !m.done(G));
  if (!missed.length) return (G.L.missed || []).length ? `<div class="section-h">Missed opportunities</div><p class="muted">None. You used every key lever of this shift.</p>` : '';
  return `<div class="section-h">Missed opportunities</div><ul class="missed">${missed.map(m => `<li>${esc(m.text)}</li>`).join('')}</ul>`;
}
