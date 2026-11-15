'use strict';
// Isometric 2.5D renderer: palettes, primitives and scene drawing.

const TW = 64, TH = 32, TZ = 34, GW = 23, GH = 7;

const PALETTES = {
  dark: {
    topL: .14, sideD: .28, glow: 14,
    slab: '#10162c', floorA: '#1d2646', floorB: '#1a2240',
    platform: '#29345c', machine: '#3a4777', screen: '#5fd4ff', desk: '#4b4066',
    belt: '#2c3457', stripe: 'rgba(120,200,255,.22)', pipe: '#34416d', pulse: '#4ff0ff',
    crate: { biz: '#4ea3ff', int: '#2fe0a0', chg: '#ffd25a', unp: '#ff4f5e' },
    gray: '#7c86a6',
    skin: '#e8b99a', hair: '#2a2233', pants: '#2c3350',
    shirts: ['#5a78c8', '#3fa58a', '#c0697f', '#8a6fd0'],
    hero: '#ff9a3c', officer: '#0f1629',
    house: '#2f3a66', roof: '#6a4fb0', win: '#ffd86b',
    rust: 'rgba(200,110,60,.38)', shadow: 'rgba(0,0,0,.38)',
    text: '#e3e9ff', pill: 'rgba(16,23,46,.88)', track: 'rgba(255,255,255,.1)',
    good: '#2fe0a0', warn: '#ffc145', bad: '#ff4f5e', pool: 'rgba(90,150,255,.13)',
    select: '#ffd25a', fog: [205, 215, 240],
  },
  light: {
    topL: .2, sideD: .16, glow: 0,
    slab: '#d6ccbc', floorA: '#ede7dd', floorB: '#e6dfd3',
    platform: '#f8f4ee', machine: '#9fabbc', screen: '#cfe8f7', desk: '#cfa57c',
    belt: '#7d8696', stripe: 'rgba(255,255,255,.28)', pipe: '#bcc5d2', pulse: '#2f8fd6',
    crate: { biz: '#4f86d4', int: '#3fae78', chg: '#eeb13c', unp: '#e5503d' },
    gray: '#aaa49a',
    skin: '#f1c7a5', hair: '#5b4636', pants: '#4a5468',
    shirts: ['#6f8fbf', '#88b08f', '#c98f6b', '#9b86c4'],
    hero: '#ef8a3a', officer: '#2f3a4f',
    house: '#f6efe3', roof: '#d97b5f', win: '#a9d3ee',
    rust: 'rgba(150,85,45,.45)', shadow: 'rgba(70,55,35,.17)',
    text: '#33394a', pill: 'rgba(255,255,255,.9)', track: 'rgba(0,0,0,.09)',
    good: '#3a9e6a', warn: '#dc8f1f', bad: '#e5503d', pool: null,
    select: '#ef8a3a', fog: [255, 255, 255],
  },
};
let PAL = PALETTES.dark;

const cv = document.getElementById('scene');
const ctx = cv.getContext('2d');
const VIEW = { dpr: 1, scale: 1, ox: 0, oy: 0 };
const faceCache = new Map();

function setPalette(name) { PAL = PALETTES[name]; faceCache.clear(); }

// ---------- primitives ----------
function rgb(c) { const n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function mix(c, t, a) {
  const A = rgb(c), B = rgb(t);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * a).toString(16).padStart(2, '0')).join('');
}
function faces(c) {
  let f = faceCache.get(c);
  if (!f) { f = { t: mix(c, '#ffffff', PAL.topL), l: c, r: mix(c, '#000000', PAL.sideD) }; faceCache.set(c, f); }
  return f;
}
function P(x, y, z) { return [(x - y) * TW / 2, (x + y) * TH / 2 - z * TZ]; }
function poly(pts, fill) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = fill; ctx.lineWidth = .6; ctx.stroke();
}
function glowOn(c, s = 1) { if (PAL.glow) { ctx.shadowColor = c; ctx.shadowBlur = PAL.glow * s; } }
function glowOff() { ctx.shadowBlur = 0; }
function box(x, y, z, w, d, h, c, glow) {
  const x1 = x + w, y1 = y + d, z1 = z + h, f = faces(c);
  if (glow) glowOn(c);
  poly([P(x, y1, z), P(x1, y1, z), P(x1, y1, z1), P(x, y1, z1)], f.l);
  poly([P(x1, y, z), P(x1, y1, z), P(x1, y1, z1), P(x1, y, z1)], f.r);
  poly([P(x, y, z1), P(x1, y, z1), P(x1, y1, z1), P(x, y1, z1)], f.t);
  if (glow) glowOff();
}
function frontQuad(xa, xb, y, za, zb, c, glow) {
  if (glow) glowOn(c);
  poly([P(xa, y, za), P(xb, y, za), P(xb, y, zb), P(xa, y, zb)], c);
  if (glow) glowOff();
}
function shadowEll(x, y, z, r, a = 1) {
  const [sx, sy] = P(x, y, z);
  ctx.globalAlpha = a;
  ctx.beginPath(); ctx.ellipse(sx, sy, r * TW * .5, r * TH * .5, 0, 0, Math.PI * 2);
  ctx.fillStyle = PAL.shadow; ctx.fill();
  ctx.globalAlpha = 1;
}
function floorOutline(x0, y0, x1, y1, z, color, width, dash) {
  ctx.save();
  glowOn(color);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)].forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p));
  ctx.closePath(); ctx.stroke();
  ctx.restore();
}

// ---------- view ----------
function fitView(rect) {
  VIEW.dpr = devicePixelRatio || 1;
  const W = innerWidth, H = innerHeight;
  if (cv.width !== W * VIEW.dpr || cv.height !== H * VIEW.dpr) {
    cv.width = W * VIEW.dpr; cv.height = H * VIEW.dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }
  const minX = -GH * TW / 2, maxX = GW * TW / 2;
  const minY = -3.4 * TZ, maxY = (GW + GH) * TH / 2 + .5 * TZ;
  VIEW.scale = Math.min(rect.w / (maxX - minX), rect.h / (maxY - minY));
  VIEW.ox = rect.x + rect.w / 2 - (minX + maxX) / 2 * VIEW.scale;
  VIEW.oy = rect.y + rect.h / 2 - (minY + maxY) / 2 * VIEW.scale;
}
function toScreen(x, y, z) { const [px, py] = P(x, y, z); return [px * VIEW.scale + VIEW.ox, py * VIEW.scale + VIEW.oy]; }
function toWorld(mx, my) {
  const a = (mx - VIEW.ox) / VIEW.scale / (TW / 2), b = (my - VIEW.oy) / VIEW.scale / (TH / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

// ---------- static decoration ----------
const RUST = (() => {
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (const sx of [5.5, 9.5, 17.5]) for (let k = 0; k < 5; k++)
    out.push({ x: sx - 1.1 + r() * 2.2, y: 1.0 + r() * 2.5, r: 5 + r() * 7 });
  for (let k = 0; k < 6; k++) out.push({ x: 2 + r() * 18, y: 4.8 + r() * 1.8, r: 6 + r() * 8 });
  return out.sort(() => r() - .5);
})();

// ---------- scene ----------
function drawScene(G, ui) {
  const T = G.t * DAY_SEC;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const k = VIEW.dpr * VIEW.scale;
  ctx.setTransform(k, 0, 0, k, VIEW.dpr * VIEW.ox, VIEW.dpr * VIEW.oy);
  drawFloor(G, ui, T);
  for (const d of buildDrawables(G, T)) d.f();
  drawFog(G, T);
  drawOverlays(G, ui, T);
}

function platformRect(s) {
  if (s.key === 'gate') return [s.x - 1.1, 3.0, s.x + 1.6, 5.2];
  return [s.x - 1.3, .9, s.x + 1.3, 3.6];
}

function drawFloor(G, ui, T) {
  box(0, 0, -.5, GW, GH, .5, PAL.slab);
  for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++)
    poly([P(i, j, 0), P(i + 1, j, 0), P(i + 1, j + 1, 0), P(i, j + 1, 0)], (i + j) % 2 ? PAL.floorA : PAL.floorB);

  const cons = constraintIndex(G);
  if (PAL.pool) {
    for (const s of G.st) {
      const [sx, sy] = P(s.x, 2.6, 0);
      const alarm = s.i === cons && s.q.length > 8;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 150);
      g.addColorStop(0, alarm ? `rgba(255,70,90,${.12 + .07 * Math.sin(T * 5)})` : PAL.pool);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(sx, sy, 150, 75, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  for (const s of G.st) if (s.key !== 'gate') box(s.x - 1.3, .9, 0, 2.6, 2.7, .12, PAL.platform);
  box(G.st[3].x + .4, 1.5, 0, 1.2, 1.4, .12, PAL.platform);

  // tech debt rust
  const n = Math.round(clamp(G.debt, 0, 100) / 100 * RUST.length);
  ctx.fillStyle = PAL.rust;
  for (let i = 0; i < n; i++) {
    const r = RUST[i], [sx, sy] = P(r.x, r.y, r.y < 3.6 ? .12 : 0);
    ctx.beginPath(); ctx.ellipse(sx, sy, r.r, r.r / 2, 0, 0, Math.PI * 2); ctx.fill();
  }

  // hover / target highlights
  for (const s of G.st) {
    const [x0, y0, x1, y1] = platformRect(s);
    if (ui.targeting && ui.validTarget(s)) floorOutline(x0, y0, x1, y1, .13, PAL.select, 1.5, [6, 4]);
    if (ui.hover === s.i || ui.selected === s.i) floorOutline(x0, y0, x1, y1, .13, PAL.select, 2.5);
  }
  if (ui.tourRect) {
    const [x0, y0, x1, y1] = ui.tourRect, a = .1 + .06 * Math.sin(T * 4);
    ctx.globalAlpha = a;
    poly([P(x0, y0, .14), P(x1, y0, .14), P(x1, y1, .14), P(x0, y1, .14)], PAL.select);
    ctx.globalAlpha = 1;
    floorOutline(x0, y0, x1, y1, .14, PAL.select, 3, [10, 6]);
  }
  for (const p of G.pulses) {
    const s = G.st[p.i], k = (G.t - p.t0) / .6, [sx, sy] = P(s.x, 2.25, .13);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - k);
    glowOn(PAL.select);
    ctx.strokeStyle = PAL.select; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(sx, sy, 50 + k * 90, (50 + k * 90) / 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  if (G.marked != null) {
    const s = G.st[G.marked], [sx, sy] = P(s.x, 2.25, .13);
    ctx.save();
    glowOn(PAL.bad);
    ctx.strokeStyle = PAL.bad; ctx.lineWidth = 2.5; ctx.setLineDash([10, 7]);
    ctx.lineDashOffset = -T * 20;
    ctx.beginPath(); ctx.ellipse(sx, sy, 105, 52, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // belt
  box(.6, 4.25, 0, 20.6, .5, .2, PAL.belt);
  const off = (T * BELT_SPEED / DAY_SEC) % .5;
  ctx.strokeStyle = PAL.stripe; ctx.lineWidth = 1.5;
  for (let x = .6 + off; x < 21.2; x += .5) {
    ctx.beginPath(); ctx.moveTo(...P(x, 4.25, .2)); ctx.lineTo(...P(x, 4.75, .2)); ctx.stroke();
  }

  // feedback pipe (right -> left). Quality G.fq drives speed, brightness and breakage.
  const broken = G.fq < .2;
  for (let x = 2; x <= 20; x += 4) box(x, .25, 0, .12, .12, 2.5, PAL.pipe);
  if (broken) {
    box(1, .2, 2.5, 8.6, .22, .22, PAL.pipe);
    box(10.6, .2, 2.5, 10.9, .22, .22, PAL.pipe);
    if (Math.sin(T * 9) > .3) {
      glowOn(PAL.warn); ctx.fillStyle = PAL.warn;
      for (let k2 = 0; k2 < 4; k2++) {
        const [sx, sy] = P(10.1 + Math.sin(T * 30 + k2) * .3, .31, 2.6 - k2 * .12);
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
      }
      glowOff();
    }
  } else {
    box(1, .2, 2.5, 20.5, .22, .22, PAL.pipe);
  }
  const pulses = Math.round(2 + G.fq * 6), pspeed = .6 + G.fq * 3.2;
  glowOn(PAL.pulse, 1.2);
  ctx.fillStyle = PAL.pulse;
  ctx.globalAlpha = .35 + G.fq * .65;
  for (let k2 = 0; k2 < pulses; k2++) {
    const px = 21.3 - ((T * pspeed + k2 * 20.3 / pulses) % 20.3);
    if (broken && px < 10.6) continue;
    const [sx, sy] = P(px, .31, 2.72);
    ctx.beginPath(); ctx.ellipse(sx, sy, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  glowOff();
}

function shirtColor(w) {
  if (w.kind === 'hero') return PAL.hero;
  if (w.kind === 'officer') return PAL.officer;
  if (w.kind === 'fire') return PAL.crate.unp;
  return PAL.shirts[w.shirt % 4];
}

function person(x, y, z, o) {
  const b = o.bob || 0;
  shadowEll(x, y, z, .32);
  box(x - .09, y - .06, z, .18, .12, .24, PAL.pants);
  box(x - .12, y - .08, z + .24 + b, .24, .16, .27, o.shirt);
  box(x - .1, y - .1, z + .51 + b, .2, .2, .19, PAL.skin);
  ctx.fillStyle = '#2a2430';
  for (const ex of [-.045, .045]) {
    const [sx, sy] = P(x + ex, y + .1, z + .61 + b);
    ctx.fillRect(sx - 1, sy - 1.5, 2, 3);
  }
  if (o.cap) {
    box(x - .105, y - .105, z + .68 + b, .21, .21, .07, o.cap);
    box(x - .105, y + .1, z + .68 + b, .21, .08, .025, o.cap);
  } else {
    box(x - .105, y - .105, z + .68 + b, .21, .21, .05, PAL.hair);
  }
  if (o.star) {
    const [sx, sy] = P(x, y, z + 1.05 + b);
    glowOn(PAL.hero, 1.2);
    ctx.fillStyle = PAL.hero;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 2.6 : 6.5, a = -Math.PI / 2 + k * Math.PI / 5 + o.T;
      ctx.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r * .8);
    }
    ctx.closePath(); ctx.fill(); glowOff();
  }
}

function crateColor(G, c) {
  if (!c.classified) return PAL.gray;
  return PAL.crate[c.type];
}

// Work-type symbols: shape-coding in addition to colour.
// briefcase = business project, gear = internal IT, cycle arrow = change, ! = unplanned
const TYPE_SVG = {
  biz: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5h6v3M3 13h18"/>',
  int: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5M5.3 5.3l2.5 2.5M16.2 16.2l2.5 2.5M5.3 18.7l2.5-2.5M16.2 7.8l2.5-2.5"/>',
  chg: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  unp: '<path d="M12 4v10"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>',
};
function typeIcon(t, cls = '') {
  return `<span class="ticon ${t} ${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${TYPE_SVG[t]}</svg></span>`;
}
function crateGlyph(type, sx, sy, col) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.strokeStyle = ctx.fillStyle = col;
  ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (type === 'biz') {
    ctx.rect(-3.6, -1.8, 7.2, 5); ctx.moveTo(-1.6, -1.8); ctx.lineTo(-1.6, -3.4); ctx.lineTo(1.6, -3.4); ctx.lineTo(1.6, -1.8);
    ctx.stroke();
  } else if (type === 'int') {
    ctx.arc(0, 0, 1.9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; ctx.moveTo(Math.cos(a) * 2.4, Math.sin(a) * 2.4); ctx.lineTo(Math.cos(a) * 3.8, Math.sin(a) * 3.8); }
    ctx.stroke();
  } else if (type === 'chg') {
    ctx.arc(0, 0, 3, -.2 * Math.PI, 1.55 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(2.9, -3.9); ctx.lineTo(2.6, -.8); ctx.lineTo(-.3, -1.6); ctx.stroke();
  } else if (type === 'unp') {
    ctx.moveTo(0, -3.6); ctx.lineTo(0, 1); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 3.2, .9, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawCrate(G, c, T) {
  const col = crateColor(G, c);
  if (c.state === 'fall') shadowEll(c.x + .15, c.y + .15, BELT_Z, .35, Math.max(.2, 1 - c.z / 7));
  box(c.x, c.y, c.z, .3, .3, .3, col, true);
  ctx.strokeStyle = mix(col, '#000000', .22); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(...P(c.x + .15, c.y, c.z + .3)); ctx.lineTo(...P(c.x + .15, c.y + .3, c.z + .3)); ctx.stroke();
  if (c.classified) {
    // sticker on the front edge of the crate
    const [gx, gy] = P(c.x + .3, c.y + .3, c.z + .16);
    crateGlyph(c.type, gx, gy, mix(col, '#000000', .62));
  } else {
    const [sx, sy] = P(c.x + .15, c.y + .15, c.z + .3);
    ctx.fillStyle = PAL.text; ctx.font = '800 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', sx, sy - 9);
  }
  if (c.type === 'unp') flame(c.x + .15, c.y + .15, c.z + .3, T, c.size || 1);
  if (c.needsHero && G.L.showHero) {
    const [sx, sy] = P(c.x + .22, c.y + .08, c.z + .3);
    glowOn(PAL.hero); ctx.fillStyle = PAL.hero;
    ctx.beginPath(); ctx.arc(sx, sy - 1, 2.6, 0, Math.PI * 2); ctx.fill(); glowOff();
  }
  if (c.rework) {
    const [sx, sy] = P(c.x + .08, c.y + .22, c.z + .3);
    ctx.fillStyle = PAL.bad;
    ctx.beginPath(); ctx.arc(sx, sy - 1, 2.6, 0, Math.PI * 2); ctx.fill();
  }
  if (c.state === 'proc' && c.w && c.w.dur > 0 && (!c.w.batch || c.w.batch[0] === c)) {
    const pr = clamp(1 - c.w.timer / c.w.dur, 0, 1);
    const top = c.w.batch ? c.z + .3 * c.w.batch.length : c.z;
    const [sx, sy] = P(c.x + .15, c.y + .15, top + .7);
    ctx.fillStyle = PAL.track; ctx.fillRect(sx - 12, sy, 24, 4);
    ctx.fillStyle = col; ctx.fillRect(sx - 12, sy, 24 * pr, 4);
  }
}
function flame(x, y, z, T, size) {
  const [sx, sy] = P(x, y, z), f = Math.sin(T * 22 + x * 7) * 2.5, s = 1 + (size - 1) * .25;
  glowOn('#ff7a2d', 1.4);
  ctx.fillStyle = '#ff7a2d';
  ctx.beginPath(); ctx.moveTo(sx - 7 * s, sy); ctx.lineTo(sx + 7 * s, sy); ctx.lineTo(sx + f, sy - (17 + f) * s); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffd45a';
  ctx.beginPath(); ctx.moveTo(sx - 3.5 * s, sy); ctx.lineTo(sx + 3.5 * s, sy); ctx.lineTo(sx + f * .6, sy - 9 * s); ctx.closePath(); ctx.fill();
  glowOff();
}

function house(x, y, alarm, T) {
  const w = .9, z1 = .6;
  box(x, y, 0, w, w, z1, PAL.house);
  frontQuad(x + .12, x + .34, y + w, .25, .45, alarm && Math.sin(T * 8) > 0 ? PAL.bad : PAL.win, true);
  frontQuad(x + .52, x + .72, y + w, 0, .4, mix(PAL.roof, '#000000', .2));
  const ap = P(x + w / 2, y + w / 2, z1 + .45), f = faces(PAL.roof);
  poly([P(x + w, y, z1), P(x + w, y + w, z1), ap], f.r);
  poly([P(x, y + w, z1), P(x + w, y + w, z1), ap], f.l);
}

function hiddenByFog(G, c) {
  return G.fogA > .5 && c.loc >= 1 && c.loc <= 4 && (c.state === 'queue' || c.state === 'proc' || c.state === 'out');
}

function buildDrawables(G, T) {
  const D = [];
  const add = (k, f) => D.push({ k, f });
  const H = G.hero;

  for (const s of G.st) {
    const x = s.x;
    if (s.key === 'demand') {
      const w = s.workers[0];
      add(x + 2.3, () => person(x, 2.3, .12, { shirt: shirtColor(w), bob: Math.abs(Math.sin(T * 4)) * .02 }));
      add(x + 3, () => box(x - .6, 2.8, .12, 1.2, .45, .38, PAL.desk));
      continue;
    }
    if (s.key === 'gate') {
      add(x + 4.0, () => box(x - .1, 3.95, 0, .2, .2, 1.3, PAL.machine));
      add(x + 5.05, () => box(x - .1, 4.85, 0, .2, .2, 1.3, PAL.machine));
      const busy = s.workers.some(w => w.cur);
      add(x + 20, () => {
        box(x - .15, 3.95, 1.3, .3, 1.1, .16, PAL.machine);
        ctx.globalAlpha = busy ? .6 + .4 * Math.sin(T * 14) : .25;
        frontQuad(x - .12, x + .12, 5.05, 1.22, 1.29, PAL.bad, busy);
        ctx.globalAlpha = 1;
      });
      add(x + 1 + 2.1, () => box(x + .6, 1.7, .12, .7, .6, .8, PAL.machine));
    } else if (s.key === 'ops') {
      add(x + 1.3, () => {
        box(x - .7 - .3, 1.1, .12, .55, .5, 1.45, PAL.machine);
        for (let k = 0; k < 5; k++) {
          const on = Math.sin(T * 6 + k * 1.7) > 0;
          frontQuad(x - .9, x - .8, 1.6, .35 + k * .22, .41 + k * .22, on ? PAL.good : PAL.track, on);
        }
        const alarm = G.incidents.some(i => !i.resolved && !i.drill && i.start <= G.t) && Math.sin(T * 8) > 0;
        box(x - .8, 1.25, 1.57, .15, .15, .12, alarm ? PAL.bad : mix(PAL.bad, '#808080', .6), alarm);
      });
    } else {
      add(x + 1.3, () => {
        box(x - .9, 1.15, .12, .75, .45, .85, PAL.machine);
        frontQuad(x - .82, x - .23, 1.6, .45, .85, PAL.screen, true);
      });
    }
    if (s.key !== 'gate') add(x + 3.05, () => box(x - .8, 2.8, .12, 1.6, .45, .38, PAL.desk));
    for (const w of s.workers) {
      if (w.kind === 'hero') continue;
      const sp = workerSpot(s, w);
      const onPlat = sp.y < 3.6;
      add(sp.x + sp.y, () => person(sp.x, sp.y, onPlat ? .12 : 0, {
        shirt: shirtColor(w), cap: w.kind === 'officer' ? PAL.officer : null,
        bob: w.cur ? Math.abs(Math.sin(T * 9 + sp.x * 5)) * .03 : 0,
      }));
    }
  }

  const walking = H.path.length > 0;
  const hw = heroWorker(G);
  add(H.x + H.y, () => person(H.x, H.y, H.y < 3.6 ? .12 : 0, {
    shirt: PAL.hero, star: true, T,
    bob: walking ? Math.abs(Math.sin(T * 12)) * .06 : ((hw.cur || H.cur) ? Math.abs(Math.sin(T * 10)) * .03 : 0),
  }));

  for (const c of G.backlog) add(c.x + c.y + .3 + c.z * .05, () => drawCrate(G, c, T));
  for (const c of G.crates) {
    if (hiddenByFog(G, c)) continue;
    add(c.x + .15 + c.y + .15 + c.z * .05, () => drawCrate(G, c, T));
  }
  const alarm = G.incidents.some(i => !i.resolved && !i.drill && i.start <= G.t);
  add(21.6 + .9 + .9 + .45, () => house(21.6, .9, alarm, T));
  add(21.8 + 2.3 + .9, () => house(21.8, 2.3, alarm, T));
  add(21.7 + 5.4 + .9, () => house(21.7, 5.4, alarm, T));

  D.sort((a, b) => a.k - b.k);
  return D;
}

function drawFog(G, T) {
  if (G.fogA <= 0.01) return;
  const [r, g, b] = PAL.fog;
  for (let i = 1; i <= 4; i++) {
    const s = G.st[i];
    for (let k = 0; k < 7; k++) {
      const fx = s.x - 1.6 + (k % 4) * .9 + Math.sin(T * .6 + k + i) * .25;
      const fy = 2.2 + Math.floor(k / 4) * 1.6 + Math.cos(T * .5 + k * 2) * .2;
      const [sx, sy] = P(fx, fy, .7);
      const rad = 46 + (k % 3) * 10;
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      grd.addColorStop(0, `rgba(${r},${g},${b},${.55 * G.fogA})`);
      grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.ellipse(sx, sy, rad, rad * .6, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawOverlays(G, ui, T) {
  for (const s of G.st) {
    const [sx, sy] = s.key === 'gate' ? P(s.x, 4.5, 2.4) : P(s.x, 2, 2.6);
    if (s.i > 0) {
      const u = G.fogA > .5 ? 0 : s.u;
      const col = u < .7 ? PAL.good : u < .9 ? PAL.warn : PAL.bad;
      ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.strokeStyle = PAL.track;
      ctx.beginPath(); ctx.arc(sx, sy, 15, 0, Math.PI * 2); ctx.stroke();
      if (G.fogA <= .5) {
        glowOn(col); ctx.strokeStyle = col;
        ctx.beginPath(); ctx.arc(sx, sy, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * u); ctx.stroke();
        glowOff();
      }
      ctx.fillStyle = PAL.text; ctx.font = '700 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(G.fogA > .5 ? '?' : Math.round(u * 100) + '%', sx, sy + .5);
      let label = s.name;
      if (s.limit != null) label += `  ${stationCount(G, s.i)}/${s.limit}`;
      pill(label, sx, sy + 28, s.limit != null && stationCount(G, s.i) > s.limit ? PAL.bad : null);
    } else {
      pill(`Demand · ${G.backlog.length} waiting`, sx, sy);
    }
  }
  const [cx, cy] = P(22.2, 3.6, 1.9);
  pill('Customers', cx, cy);
  const open = G.incidents.filter(i => !i.resolved && !i.drill && i.start <= G.t).length;
  if (open) pill(`⚠ ${open} incident${open > 1 ? 's' : ''}`, cx, cy - 24, PAL.bad);

  const ops = G.st[4];
  if (G.batch > 1) {
    const waiting = ops.q.filter(c => c.type !== 'unp').length;
    const [bx, by] = P(ops.x + .9, 4.5, 1.4);
    pill(`Batch ${Math.min(waiting, G.batch)}/${G.batch}`, bx, by);
  }

  const H = G.hero;
  if (H.bubble > G.t) bubble('!', H.x, H.y);
  else if (H.doc && H.state === 'home') bubble('✎', H.x, H.y);
  else if (G.t < H.burnUntil && G.t >= H.otUntil) bubble('z', H.x, H.y);

  for (const f of G.flashes) {
    const p = (G.t - f.t0) / .15;
    if (p > 1) continue;
    const [sx, sy] = P(f.x, f.y, f.z);
    ctx.globalAlpha = 1 - p;
    glowOn(f.col); ctx.strokeStyle = f.col; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(sx, sy, 20 + p * 60, (20 + p * 60) * .5, 0, 0, Math.PI * 2); ctx.stroke();
    glowOff();
  }
  ctx.globalAlpha = 1;

  for (const p of G.sparks) {
    const [sx, sy] = P(p.x, p.y, p.z);
    ctx.globalAlpha = clamp(p.life / .04, 0, 1);
    glowOn(p.col); ctx.fillStyle = p.col;
    ctx.beginPath(); ctx.moveTo(sx, sy - 3); ctx.lineTo(sx + 3, sy); ctx.lineTo(sx, sy + 3); ctx.lineTo(sx - 3, sy); ctx.fill();
    glowOff();
  }
  ctx.globalAlpha = 1;
}
function pill(text, x, y, color) {
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = color || PAL.pill;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - 10, w, 20, 10); ctx.fill();
  ctx.fillStyle = color ? '#ffffff' : PAL.text;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + .5);
}
function bubble(t, x, y) {
  const [sx, sy] = P(x, y, 1.35);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(sx - 11, sy - 30, 22, 20, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(sx - 4, sy - 11); ctx.lineTo(sx + 4, sy - 11); ctx.lineTo(sx, sy - 5); ctx.fill();
  ctx.fillStyle = '#e5503d'; ctx.font = '800 13px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t, sx, sy - 20);
}
