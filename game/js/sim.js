'use strict';
// Factory simulation. All times are in-game days.

const DAY_SEC = 8;
// Some shifts run more, shorter days (tScale k): a day lasts DAY_SEC / k seconds. Visual timers,
// patience and KPI windows scale with k, so the shift feels the same but has k× more flow to measure.
function daySec(G) { return DAY_SEC / (G.k || 1); }
// Volume (vScale v): v× more items, each done v× faster. Lead times stay, piles and throughput grow v×.
// Per-item effects (patience, budget, crowding) are divided by v so the totals stay comparable.
const BELT_Y = 4.35, BELT_Z = .2, BELT_SPEED = 30, LAYERS = 4;
const STATION_X = [1.6, 5.5, 9.5, 13.5, 17.5];
const CUST_X = 21.0;
const GATE_SPOTS = [[.65, 3.75], [1.15, 3.45], [.55, 3.2]];
let crateId = 0;

// Seeded randomness: the same seed replays the same shift, which powers the
// "untouched factory" comparison. Code outside update() falls back to Math.random.
let RNG = Math.random;
function rand() { return RNG(); }
function mulberry32(a) {
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function withRng(rng, fn) {
  const prev = RNG;
  RNG = rng;
  try { return fn(); } finally { RNG = prev; }
}
function rnd(a, b) { return a + rand() * (b - a); }
function lerp(a, b, k) { return a + (b - a) * k; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

// ---------- setup ----------
function makeWorker(kind, shirt = 0) {
  return { kind, shirt, dx: 0, slot: 0, cur: null, batch: null, timer: 0, dur: 0, u: 0, isHero: kind === 'hero' };
}
function layoutWorkers(s) {
  const sets = { 1: [0], 2: [-.45, .45], 3: [-.6, 0, .6], 4: [-.66, -.22, .22, .66] };
  const xs = sets[Math.min(4, s.workers.length)];
  s.workers.forEach((w, i) => { w.dx = xs[i] ?? 0; w.slot = i; });
}
function workerSpot(s, w) {
  if (s.key === 'gate') { const g = GATE_SPOTS[w.slot % 3]; return { x: s.x + g[0], y: g[1] }; }
  return { x: s.x + w.dx, y: 2.3 };
}
function heroWorker(G) { return G.st[4].workers.find(w => w.isHero); }

function makeStations(L) {
  const W = L.workers || {};
  const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const st = [
    { key: 'demand', name: 'Demand', workers: [makeWorker('pm', 3)] },
    { key: 'dev', name: 'Dev', workers: rep(W.dev ?? 2, i => makeWorker('normal', i)) },
    { key: 'test', name: 'Test', workers: rep(W.test ?? 1, i => makeWorker('normal', 2 + i)) },
    { key: 'gate', name: 'Change Gate', workers: rep(W.gate ?? 1, () => makeWorker('officer')) },
    { key: 'ops', name: 'Ops / Deploy', workers: [...rep(W.ops ?? 1, () => makeWorker('junior', 1)), makeWorker('hero')] },
  ];
  st.forEach((s, i) => {
    s.i = i; s.x = STATION_X[i]; s.q = []; s.out = []; s.limit = null; s.u = 0;
    s.heroProb = (L.heroProb || {})[s.key] || 0;
    layoutWorkers(s);
  });
  return st;
}

function newGame(L, opts = {}) {
  const seed = opts.seed ?? (Math.random() * 4294967296) >>> 0;
  const rng = mulberry32(seed);
  return withRng(rng, () => buildGame(L, opts, seed, rng));
}
function buildGame(L, opts, seed, rng) {
  const G = {
    L, t: 0, k: L.tScale || 1, v: L.vScale || 1, speed: 1, ended: null, demo: !!opts.demo, ghost: !!opts.ghost, seed, rng,
    st: makeStations(L), backlog: [], crates: [], sparks: [], flashes: [],
    patience: L.patience ?? 70, budget: L.budget ?? 0,
    debt: L.debt ?? 10, debtShare: L.debtShare ?? (L.mix ? L.mix.int : .2),
    fq: L.fq ?? .4, batch: L.batch ?? 1,
    flags: Object.assign({}, L.flags || {}), owned: {}, locks: {},
    toolUses: {}, decisions: [], choices: {}, patFx: [], patLog: [], patDrain: { incidents: 0, backlog: 0, wip: 0 }, pulses: [], fx: [],
    stats: { delivered: [], resolved: [], deploys: [], mttr: [], reworks: 0, interruptions: 0 },
    incidents: [], pending: [],
    arrivalT: .15, fireT: rnd(.4, 1.2), shadowT: rnd(.2, .8), releaseCd: 0,
    marked: null, fogA: L.fog ? 1 : 0, kanbanT: null, peek: {}, peeked: new Set(), disc: {}, seen: {},
    hero: { x: 0, y: 2.3, state: 'home', path: [], dest: null, cur: null, timer: 0, dur: 0, bubble: -1,
      doc: null, otUntil: -1, burnUntil: -1, errandUntil: -1 },
    teamOT: null, resilience: 1,
    mentorQ: [], fired: new Set(), events: (L.events || []).map((e, idx) => Object.assign({ done: false, idx }, e)),
    schedule: [], kpi: {}, series: {}, seriesT: [], sampleT: 0, pendingModal: null,
    steps: { identify: false, exploit: false, subordinate: false, elevate: false },
    tut: { idx: 0, correct: 0, nextT: .3, answers: [] },
  };
  const sp = workerSpot(G.st[4], heroWorker(G));
  G.hero.x = sp.x; G.hero.y = sp.y;
  if (L.preload) preload(G, L.preload);
  if (L.backlog) for (let i = 0; i < L.backlog; i++) addToBacklog(G, newCrate(G, pickType(G)));
  if (L.setup) L.setup(G);
  return G;
}

function newCrate(G, type) {
  return {
    id: ++crateId, type, loc: 0, state: 'backlog', x: 1, y: 1.5, z: .12,
    born: G.t, released: null, needsHero: false, rolledAt: -1, defect: false, rework: false,
    risk: type === 'chg' ? (rand() < (G.L.risky ?? .3) ? 'risky' : 'std') : null,
    inScope: rand() < .4, shadow: false, classified: true, reviewed: false, w: null,
  };
}
function pickType(G) {
  const m = G.L.mix || { biz: .45, int: .2, chg: .35 };
  if (G.L.debtSlider) {
    // the paydown slider is a reservation, so allocate internal work deterministically
    G.intAcc = (G.intAcc || 0) + G.debtShare;
    if (G.intAcc >= 1) { G.intAcc -= 1; return 'int'; }
    return rand() < m.biz / (m.biz + m.chg) ? 'biz' : 'chg';
  }
  const r = rand();
  if (r < m.int) return 'int';
  return r < m.int + m.biz ? 'biz' : 'chg';
}
function addToBacklog(G, c) {
  const pile = backlogSlot(G.backlog.length);
  c.x = pile[0]; c.y = pile[1]; c.z = pile[2] + 1.5;
  G.backlog.push(c);
}
function preload(G, spec) {
  for (const key of Object.keys(spec)) {
    const s = G.st.find(x => x.key === key);
    for (let k = 0; k < spec[key] * G.v; k++) {
      const c = newCrate(G, pickType(G));
      const [a0, a1] = G.L.preloadAge || [1, 4];
      c.released = -rnd(a0, a1); c.loc = s.i; c.state = 'queue';
      rollHero(G, s, c);
      s.q.push(c); G.crates.push(c);
      const p = slot(s, s.q.length - 1); c.x = p[0]; c.y = p[1]; c.z = p[2];
    }
  }
}

// ---------- geometry helpers ----------
function slot(s, i) {
  const n = s.q.length;
  const spacing = Math.min(.4, 2.5 / Math.max(1, Math.ceil(n / LAYERS)));
  const col = Math.floor(i / LAYERS), layer = i % LAYERS;
  return [s.x - .75 - col * spacing, BELT_Y, BELT_Z + layer * .32];
}
function outSlot(s, i) {
  const col = Math.floor(i / 3), layer = i % 3;
  return [s.x + .4 + col * .34, BELT_Y, BELT_Z + layer * .32];
}
function backlogSlot(i) {
  const layer = Math.floor(i / 15), r = i % 15;
  return [.45 + (r % 5) * .38, 1.0 + Math.floor(r / 5) * .38, .12 + layer * .32];
}
function tailX(G, loc) {
  if (loc >= 5) return CUST_X;
  const s = G.st[loc];
  return s.x - .75 - Math.floor(s.q.length / LAYERS) * Math.min(.4, 2.5 / Math.max(1, Math.ceil((s.q.length + 1) / LAYERS)));
}

// ---------- counting ----------
const FLOOR_STATES = new Set(['move', 'queue', 'proc', 'out', 'arc', 'fall']);
function stationCount(G, i) {
  let n = 0;
  for (const c of G.crates) if (c.loc === i && c.type !== 'unp' && FLOOR_STATES.has(c.state)) n++;
  return n;
}
function floorWip(G) {
  let n = 0;
  for (const c of G.crates) if (c.type !== 'unp' && c.loc >= 1 && c.loc <= 4) n++;
  return n;
}
function stationLoad(s) { return s.q.length + s.out.length + s.workers.filter(w => w.cur).length; }
function accepts(G, i) {
  if (i >= 5) return true;
  const s = G.st[i];
  if (G.flags.utilDrive) return true;
  return s.limit == null || stationCount(G, i) < s.limit;
}
function constraintIndex(G) {
  let best = 1, bv = -1;
  for (let i = 1; i <= 4; i++) {
    const s = G.st[i], v = s.u + s.q.length * .01;
    if (v > bv) { bv = v; best = i; }
  }
  return best;
}

// ---------- rules ----------
function detectDelay(G) { return 1.2 - G.fq * 1.1; }
function pDefect(G) {
  let p = (G.L.pDef ?? .1) + G.debt * .002;
  if (G.teamOT && G.t >= G.teamOT.until && G.t < G.teamOT.burn) p += .25;
  if (G.owned.shiftLeft) p -= .04;
  return clamp(p, .01, .6);
}
function pDetect(G) {
  if (G.flags.skipTests) return .05;
  if (G.owned.autoTests) return .9;
  return .3 + G.fq * .4;
}
function needsGate(G, c) {
  if (c.type === 'unp') return false;
  const stdSkip = G.owned.preapprove && c.type === 'chg' && c.risk === 'std';
  if (G.flags.auditAll) {
    if (stdSkip) return false;
    if (G.owned.cutScope && !c.inScope && c.type !== 'chg') return false;
    return true;
  }
  return c.type === 'chg' && !stdSkip;
}
function crateFail(G, c) {
  let p;
  if (c.type === 'chg') {
    if (c.risk === 'risky') p = (G.owned.preapprove && c.reviewed) ? .06 : (G.L.riskyFail ?? .15);
    else p = G.L.stdFail ?? .03;
  } else p = .015;
  if (c.defect) p += .7;
  if (G.t >= G.hero.otUntil && G.t < G.hero.burnUntil) p += .1;
  return p;
}
function deployTime(G, n) {
  return (G.owned.deployAuto ? .03 + .02 * n : (G.L.opsSetup ?? .2) + .1 * n) / G.v;
}
function procTime(G, s, c) {
  let t;
  if (c.type === 'unp') {
    t = c.inc ? .5 : .35;
    if (c.inc && G.fq >= .9) t *= .5;
    if ((c.size || 1) > 1) t *= 1 + (c.size - 1) * .3;
    t *= G.resilience;
  } else if (s.key === 'dev') {
    t = .85 * (c.type === 'chg' ? .5 : 1) * (G.owned.shiftLeft ? 1.15 : 1) * (c.rework ? .5 : 1);
  } else if (s.key === 'test') {
    t = .42 * (c.type === 'chg' ? .6 : 1) * (G.flags.skipTests ? .3 : 1) * (c.rework ? .7 : 1);
  } else if (s.key === 'gate') {
    t = G.flags.auditAll ? (G.L.auditTime ?? .45) : .12;
    if (G.owned.shiftLeft) t *= .35;
    if (G.flags.moreApprovers) t *= 1.7;
  } else {
    t = deployTime(G, 1);
  }
  return t * rnd(.8, 1.2) / G.v;
}
function workerSpeed(G, s, w) {
  let f = 1;
  if (w.isHero) {
    if (G.t < G.hero.otUntil) f *= 1.5;
    else if (G.t < G.hero.burnUntil) f *= .55;
  }
  if (G.teamOT) {
    if (G.t < G.teamOT.until) f *= 1.3;
    else if (G.t < G.teamOT.burn) f *= .6;
  }
  const cs = ((G.L.cs ?? .03) + (G.flags.utilDrive ? .05 : 0)) / G.v;
  const over = stationLoad(s) - 2 * s.workers.length * G.v;
  if (over > 0) f /= 1 + cs * over;
  return f;
}
function rollHero(G, s, c) {
  if (c.rolledAt === s.i) return;
  c.rolledAt = s.i;
  c.needsHero = rand() < s.heroProb;
}

// ---------- spawning ----------
function spawnFire(G, i, opts = {}) {
  const s = G.st[i], c = newCrate(G, 'unp');
  c.loc = i; c.released = G.t; c.state = 'fall';
  const p = slot(s, 0);
  c.x = p[0]; c.y = BELT_Y; c.z = 7; c.vz = 0;
  c.inc = opts.inc || null; c.drill = !!opts.drill; c.size = opts.size || 1;
  G.crates.push(c);
  return c;
}
function newIncident(G, start, drill) {
  const inc = { start, resolved: null, drill: !!drill };
  G.incidents.push(inc);
  return inc;
}
function spark(G, x, y, z, col, n = 6) {
  for (let k = 0; k < n; k++)
    G.sparks.push({ x, y, z, vx: rnd(-8, 8), vy: rnd(-8, 8), vz: rnd(12, 24), life: rnd(.06, .11), col });
}
function startArc(c, x1, y1, z1, dur, h, then) {
  c.state = 'arc';
  c.arc = { x0: c.x, y0: c.y, z0: c.z, x1, y1, z1, p: 0, dur, h, then };
}

function release(G, c) {
  c.released = G.t; c.loc = 1;
  startArc(c, 2.2, BELT_Y, BELT_Z, .06, .8, 'move');
  G.crates.push(c);
}
function canRelease(G, c) {
  if (!c.classified) return false;
  if (G.flags.freeze && floorWip(G) >= (G.L.freezeWip ?? 10) * G.v) return false;
  if (c.type === 'chg' && G.locks.chgFreeze > G.t) return false;
  if (G.flags.utilDrive) return true;
  if (G.flags.rope && floorWip(G) >= (G.L.ropeN ?? 8) * G.v) return false;
  return accepts(G, 1);
}

// ---------- flow ----------
function arriveAt(G, c) {
  if (c.loc >= 5) return deliver(G, c);
  const s = G.st[c.loc];
  if (s.key === 'gate' && !needsGate(G, c)) {
    c.loc = 4;
    startArc(c, s.x + .5, BELT_Y, BELT_Z, .05, 1.6, 'move');
    return;
  }
  rollHero(G, s, c);
  c.qAt = G.t;
  if (c.type === 'unp') s.q.unshift(c);
  else if (c.shadow && c.state === 'fall') {
    // "can you just quickly…": hallway favors jump the queue
    const k = s.q.findIndex(x => x.type !== 'unp');
    s.q.splice(k < 0 ? s.q.length : k, 0, c);
  } else s.q.push(c);
  c.state = 'queue';
}

function forward(G, s, c) {
  c.w = null;
  if (s.i === 4 || accepts(G, s.i + 1)) {
    c.loc = s.i + 1; c.state = 'move';
    if (c.y < 4) c.x = s.x + .35;
  } else {
    c.state = 'out'; s.out.push(c);
  }
}

function deliver(G, c) {
  c.state = 'done';
  const lead = G.t - c.released;
  G.stats.delivered.push({ t: G.t, lead, type: c.type, shadow: c.shadow });
  if (c.shadow) {
    // a favor nobody officially asked for: it ate capacity, but the business never sees it
    spark(G, CUST_X + .3, BELT_Y + .15, .4, PAL.gray);
    return;
  }
  const onTime = lead <= (G.L.sla ?? 4);
  patienceHit(G, (onTime ? 1.5 : -(G.L.latePenalty ?? 1.5)) / G.k / G.v, onTime ? 'on-time delivery' : 'late delivery');
  G.budget += (G.L.income ?? .5) / G.k / G.v;
  if (G.L.debtDyn) {
    if (c.type === 'biz') G.debt += G.L.debtDyn.up / G.v;
    if (c.type === 'int') G.debt -= G.L.debtDyn.down / G.v;
    G.debt = clamp(G.debt, 0, 100);
  }
  spark(G, CUST_X + .3, BELT_Y + .15, .4, PAL.crate[c.type]);
  if (c.defect) {
    const inc = newIncident(G, G.t + .1);
    G.pending.push({ at: inc.start + detectDelay(G), inc, size: 1 });
  }
}

function finish(G, s, w) {
  const c = w.cur;
  w.cur = null;
  if (w.batch) return finishDeploy(G, s, w);
  if (c.type === 'unp') {
    c.state = 'done';
    G.stats.resolved.push({ t: G.t, drill: c.drill });
    if (c.inc) {
      c.inc.resolved = G.t;
      if (c.drill) { G.resilience = Math.max(.45, G.resilience * .8); mentorSay(G, 'Drill handled. Each practice run makes the team faster at the real thing. Incidents now take less time to fix.'); }
      else G.stats.mttr.push(G.t - c.inc.start);
    }
    spark(G, c.x + .15, c.y + .15, c.z + .3, PAL.good, 8);
    return;
  }
  if (s.key === 'dev') c.defect = rand() < pDefect(G) * (c.rework ? .3 : 1);
  if (s.key === 'test' && c.defect && rand() < pDetect(G)) {
    c.defect = false; c.rework = true; c.w = null;
    G.stats.reworks++;
    c.loc = 1;
    const tail = slot(G.st[1], G.st[1].q.length);
    startArc(c, tail[0], tail[1], tail[2], .1, 2.2, 'join');
    trigger(G, 'firstRework', 'Test caught a defect and sent it back to Dev. Fixing it here is cheap. In production it would have been a fire.');
    return;
  }
  if (s.key === 'gate') c.reviewed = true;
  forward(G, s, c);
}

function finishDeploy(G, s, w) {
  const items = w.batch;
  w.batch = null;
  const pf = 1 - items.reduce((p, c) => p * (1 - crateFail(G, c)), 1);
  const failed = rand() < pf;
  G.stats.deploys.push({ t: G.t, n: items.length, failed });
  G.flashes.push({ x: s.x, y: 2.8, z: .6, t0: G.t, col: failed ? PAL.bad : PAL.good });
  items.forEach((c, k) => {
    c.w = null; c.loc = 5; c.state = 'move';
    c.x = s.x + .35 - k * .32; c.y = BELT_Y; c.z = BELT_Z;
  });
  if (failed) {
    items.forEach(c => { c.defect = false; });
    const inc = newIncident(G, G.t + .05);
    G.pending.push({ at: inc.start + detectDelay(G), inc, size: items.length });
    patienceHit(G, -3 / G.k / G.v, 'failed deploy');
    trigger(G, 'firstFail', items.length > 1
      ? `A deploy of ${items.length} items just failed. Which one broke it? Big batches make failures bigger and harder to diagnose.`
      : 'A change failed in production. Customers will feel it until it is fixed.');
  }
}

function startWork(G, s, w, items) {
  const c = items[0];
  items.forEach((x, k) => {
    const i = s.q.indexOf(x);
    if (i >= 0) s.q.splice(i, 1);
    x.state = 'proc'; x.w = w; x.bi = k;
  });
  w.cur = c;
  if (s.key === 'ops' && c.type !== 'unp') {
    w.batch = items;
    w.dur = deployTime(G, items.length) * rnd(.9, 1.1);
  } else {
    w.batch = null;
    w.dur = procTime(G, s, c);
  }
  w.timer = c.resume != null ? c.resume : w.dur;
  c.resume = null;
}

function pickWork(G, s, w) {
  if (s.key === 'ops') {
    const f = s.q.find(c => c.type === 'unp' && (!c.needsHero || w.isHero));
    if (f) return [f];
    if (w.kind === 'fire') return null;
    const deploys = s.q.filter(c => c.type !== 'unp');
    if (!deploys.length) return null;
    if (G.batch <= 1) {
      const c = deploys.find(c => !c.needsHero || w.isHero);
      return c ? [c] : null;
    }
    const oldest = Math.min(...deploys.map(c => c.qAt ?? G.t));
    if (deploys.length < G.batch && G.t - oldest < 2) return null;
    const items = deploys.slice(0, G.batch);
    if (!w.isHero && items.some(c => c.needsHero)) return null;
    return items;
  }
  const c = s.q.find(c => (w.kind !== 'fire' || c.type === 'unp') && (!c.needsHero || w.isHero));
  return c ? [c] : null;
}

function heroAvailable(G) {
  const H = G.hero;
  return H.state === 'home' && !H.doc;
}

function stationStep(G, s, dt) {
  if (s.i === 0) return;
  let busy = 0;
  for (const w of s.workers) {
    if (w.isHero) {
      const H = G.hero;
      const b = !!(w.cur || H.state !== 'home' || H.doc);
      w.u += ((b ? 1 : 0) - w.u) * Math.min(1, dt);
      if (H.state !== 'home') continue;
      if (H.doc && !w.cur) continue;
    } else {
      w.u += ((w.cur ? 1 : 0) - w.u) * Math.min(1, dt);
    }
    if (w.cur) {
      w.timer -= dt * workerSpeed(G, s, w);
      if (w.timer <= 0) finish(G, s, w);
      continue;
    }
    const items = pickWork(G, s, w);
    if (items) startWork(G, s, w, items);
  }
  s.u = Math.max(...s.workers.map(w => w.u));
  // hand finished work downstream when there is room
  while (s.out.length && accepts(G, s.i + 1)) {
    const c = s.out.shift();
    c.loc = s.i + 1; c.state = 'move';
  }
}

// ---------- hero ----------
function heroRequest(G) {
  let best = null;
  for (let i = 1; i <= 3; i++) {
    const s = G.st[i];
    for (const c of s.q) if (c.needsHero && (!best || c.qAt < best.c.qAt)) best = { i, c };
  }
  return best;
}
function heroDest(G, i) {
  const s = G.st[i];
  if (i === 0) return [s.x + 1.0, 2.5];
  if (s.key === 'gate') return [s.x + .45, 3.9];
  return [s.x + 1.0, 2.55];
}
function heroWalk(G, i) {
  const H = G.hero, [tx, ty] = heroDest(G, i);
  H.path = [[H.x, 3.9], [tx, 3.9], [tx, ty]];
  H.dest = i;
}
function heroLeaveOps(G) {
  const hw = heroWorker(G), ops = G.st[4];
  if (hw.cur) {
    const items = hw.batch || [hw.cur];
    items[0].resume = hw.timer;
    for (const c of items.slice().reverse()) { c.state = 'queue'; c.w = null; ops.q.unshift(c); }
    hw.cur = null; hw.batch = null;
  }
}
function heroStep(G, dt) {
  const H = G.hero, ops = G.st[4], hw = heroWorker(G);
  const opsNeedsHero = () => hw.cur || ops.q.some(c => c.needsHero);

  if (H.state === 'home') {
    const sp = workerSpot(ops, hw);
    H.x = sp.x; H.y = sp.y;
    if (H.errandUntil > G.t) {
      heroLeaveOps(G); heroWalk(G, 0); H.state = 'walk'; H.bubble = G.t + .3;
    } else {
      const req = heroRequest(G);
      if (req && (!G.flags.protectHero || !opsNeedsHero())) {
        if (!G.flags.protectHero && hw.cur) G.stats.interruptions++;
        heroLeaveOps(G); heroWalk(G, req.i); H.state = 'walk'; H.bubble = G.t + .3;
        trigger(G, 'heroPulled', `The hero just got pulled over to ${G.st[req.i].name}. Watch what happens at Ops while they're gone.`);
      } else if (H.doc && !hw.cur) {
        H.doc.timer -= dt * workerSpeed(G, ops, hw);
        if (H.doc.timer <= 0) finishRunbook(G);
      }
    }
  }
  if (H.path.length) {
    const [tx, ty] = H.path[0], dx = tx - H.x, dy = ty - H.y, d = Math.hypot(dx, dy);
    const step = 30 * dt * (G.t >= H.otUntil && G.t < H.burnUntil ? .7 : 1);
    if (d <= step) { H.x = tx; H.y = ty; H.path.shift(); } else { H.x += dx / d * step; H.y += dy / d * step; }
    if (!H.path.length) H.state = H.state === 'walk' ? 'away' : 'home';
    return;
  }
  if (H.state === 'away') {
    if (H.dest === 0) {
      if (G.t >= H.errandUntil) goHome(G);
      return;
    }
    const s = G.st[H.dest];
    if (!H.cur) {
      const c = s.q.find(c => c.needsHero);
      const leave = !c || (G.flags.protectHero && opsNeedsHero());
      if (leave) {
        const req = heroRequest(G);
        if (req && !(G.flags.protectHero && opsNeedsHero())) { heroWalk(G, req.i); H.state = 'walk'; }
        else goHome(G);
        return;
      }
      s.q.splice(s.q.indexOf(c), 1);
      c.state = 'proc'; c.w = H; H.cur = c;
      H.dur = H.timer = procTime(G, s, c);
    } else {
      H.timer -= dt * workerSpeed(G, s, { isHero: true });
      if (H.timer <= 0) {
        const c = H.cur; H.cur = null;
        finishByHero(G, s, c);
      }
    }
  }
}
function finishByHero(G, s, c) {
  const fake = { cur: c, batch: null };
  finish(G, s, fake);
}
function goHome(G) {
  const H = G.hero, sp = workerSpot(G.st[4], heroWorker(G));
  H.path = [[H.x, 3.9], [sp.x, 3.9], [sp.x, sp.y]];
  H.state = 'return'; H.dest = 4;
}
function finishRunbook(G) {
  const H = G.hero, s = G.st[H.doc.i];
  s.heroProb = s.key === 'ops' ? Math.max(0, s.heroProb - .5) : 0;
  for (const c of s.q) { c.rolledAt = -1; rollHero(G, s, c); }
  H.doc = null;
  G.steps.elevate = true;
  mentorSay(G, s.key === 'ops' && s.heroProb > 0
    ? 'Runbook written. Others can now handle some of the deploys. Another runbook would cover the rest.'
    : `Runbook for ${s.name} is done. That station no longer needs the hero. Knowledge now flows without them.`);
}

// ---------- main update ----------
function update(G, dt) {
  if (G.ended) return;
  withRng(G.rng, () => updateInner(G, dt));
}
function updateInner(G, dt) {
  G.t += dt;
  const L = G.L;

  // arrivals
  if (L.tutorial) tutorialStep(G);
  else if (L.rate) {
    G.arrivalT -= dt;
    while (G.arrivalT <= 0) {
      G.arrivalT += (1 / (L.rate * G.v)) * rnd(.6, 1.4);
      addToBacklog(G, newCrate(G, pickType(G)));
    }
  }
  if (L.shadowRate) {
    G.shadowT -= dt;
    if (G.shadowT <= 0) {
      G.shadowT = (1 / (L.shadowRate * G.v)) * rnd(.6, 1.4);
      const c = newCrate(G, pickType(G));
      if (G.owned.singleIntake) addToBacklog(G, c);
      else {
        const i = 1 + Math.floor(rand() * 2), s = G.st[i];
        c.shadow = true; c.released = G.t; c.loc = i; c.state = 'fall';
        const p = slot(s, s.q.length); c.x = p[0]; c.y = BELT_Y; c.z = 5; c.vz = 0;
        G.crates.push(c);
      }
    }
  }
  if (L.fires) {
    G.fireT -= dt;
    if (G.fireT <= 0) {
      const rate = L.fireBase + G.debt * (L.fireDebt ?? .015);
      G.fireT = (1 / (rate * G.v)) * rnd(.6, 1.4);
      const r = rand(), i = r < .35 ? 1 : r < .6 ? 2 : 4;
      const inc = i === 4 ? newIncident(G, G.t - detectDelay(G) * .6) : null;
      spawnFire(G, i, { inc });
      if (inc) trigger(G, 'firstIncident', 'A customer-facing incident. Until it is fixed, business patience drains. How quickly did you even notice it?');
    }
  }
  for (let k = G.pending.length - 1; k >= 0; k--) {
    const p = G.pending[k];
    if (G.t >= p.at) { G.pending.splice(k, 1); spawnFire(G, 4, { inc: p.inc, size: p.size }); }
  }

  // release from Demand
  G.releaseCd -= dt;
  if (G.releaseCd <= 0 && G.backlog.length) {
    const idx = G.backlog.findIndex(c => canRelease(G, c));
    if (idx >= 0) { release(G, G.backlog.splice(idx, 1)[0]); G.releaseCd = .07 / G.v; }
  }

  heroStep(G, dt);
  for (const s of G.st) stationStep(G, s, dt);
  moveCrates(G, dt * G.k);

  // fog lifts once work is visible: a wave rolls from Dev to Ops
  if (G.owned.kanban) {
    if (G.kanbanT == null) G.kanbanT = G.t;
    if (G.t > G.kanbanT + .75 / G.k) G.fogA = Math.max(0, G.fogA - dt * 3 * G.k);
  }

  // patience
  const open = G.incidents.filter(i => !i.resolved && !i.drill && i.start <= G.t).length;
  const tol = L.backlogTol ?? 18;
  G.patDrain.incidents = open * (L.incDrain ?? 5) / G.v;
  G.patDrain.backlog = G.backlog.length > tol * G.v ? (G.backlog.length - tol * G.v) * .15 / G.v : 0;
  // everything started, nothing finished: the business feels a crowded floor directly
  const wd = L.wipDrain, fw = wd ? floorWip(G) : 0;
  G.patDrain.wip = wd && fw > wd.over * G.v ? (fw - wd.over * G.v) * wd.rate / G.v : 0;
  G.patience = clamp(G.patience - (G.patDrain.incidents + G.patDrain.backlog + G.patDrain.wip) * dt / G.k, 0, 100);

  // debt
  if (L.debtSlider && G.locks.debt > G.t) G.debtShare = 0;

  for (let k = G.schedule.length - 1; k >= 0; k--)
    if (G.t >= G.schedule[k].at) { const s = G.schedule.splice(k, 1)[0]; s.fn(G); }

  const dv = dt * G.k;
  for (const p of G.sparks) { p.x += p.vx * dv; p.y += p.vy * dv; p.z += p.vz * dv; p.vz -= 380 * dv; p.life -= dv; }
  G.sparks = G.sparks.filter(p => p.life > 0);
  G.flashes = G.flashes.filter(f => G.t - f.t0 < .2 / G.k);
  G.pulses = G.pulses.filter(p => G.t - p.t0 < .6 / G.k);

  G.sampleT -= dt;
  if (G.sampleT <= 0) { G.sampleT = .25; sampleKpis(G); }

  if (G.demo) return;
  if (!G.ghost) for (const m of L.mentor || []) if (!G.fired.has(m.id) && m.when(G)) {
    G.fired.add(m.id); mentorSay(G, m.text, m.who);
    if (m.pulse) for (const i of m.pulse) G.pulses.push({ i, t0: G.t });
  }
  for (const e of G.events) if (!e.done && G.t >= e.day && !G.pendingModal) { e.done = true; G.pendingModal = { type: 'event', ev: e }; }
  if (G.patience <= 0) G.ended = 'failed';
  else if (G.t >= L.days) G.ended = 'complete';
}

function moveCrates(G, dt) {
  const k8 = Math.min(1, dt * 60), k6 = Math.min(1, dt * 45);
  for (const c of G.crates) {
    switch (c.state) {
      case 'arc': {
        const a = c.arc;
        a.p = Math.min(1, a.p + dt / a.dur);
        c.x = lerp(a.x0, a.x1, a.p); c.y = lerp(a.y0, a.y1, a.p);
        c.z = lerp(a.z0, a.z1, a.p) + a.h * 4 * a.p * (1 - a.p);
        if (a.p >= 1) { if (a.then === 'join') arriveAt(G, c); else c.state = 'move'; }
        break;
      }
      case 'fall':
        c.vz -= 2500 * dt; c.z += c.vz * dt;
        if (c.z <= BELT_Z) {
          c.z = BELT_Z;
          spark(G, c.x + .15, c.y + .15, .3, c.type === 'unp' ? '#ff8a3d' : PAL.gray, 8);
          arriveAt(G, c);
        }
        break;
      case 'move':
        c.x += BELT_SPEED * dt;
        c.y = lerp(c.y, BELT_Y, k8); c.z = lerp(c.z, BELT_Z, k8);
        if (c.x >= tailX(G, c.loc) - .02) arriveAt(G, c);
        break;
      case 'proc': {
        const s = G.st[c.loc], w = c.w;
        let tx, ty, tz;
        if (w === G.hero) { tx = s.x + .55; ty = 2.85; tz = .5; if (s.key === 'gate') { tx = s.x - .15; ty = BELT_Y; tz = BELT_Z; } }
        else if (s.key === 'gate') { tx = s.x - .15; ty = BELT_Y; tz = BELT_Z; }
        else { const sp = workerSpot(s, w); tx = sp.x - .15; ty = 2.85; tz = .5 + (c.bi || 0) * .3; }
        c.x = lerp(c.x, tx, k6); c.y = lerp(c.y, ty, k6); c.z = lerp(c.z, tz, k6);
        break;
      }
    }
  }
  for (const s of G.st) {
    s.q.forEach((c, i) => {
      const [tx, ty, tz] = slot(s, i);
      c.x = lerp(c.x, tx, k6); c.y = lerp(c.y, ty, k6); c.z = lerp(c.z, tz, k6);
    });
    s.out.forEach((c, i) => {
      const [tx, ty, tz] = outSlot(s, i);
      c.x = lerp(c.x, tx, k6); c.y = lerp(c.y, ty, k6); c.z = lerp(c.z, tz, k6);
    });
  }
  G.backlog.forEach((c, i) => {
    const [tx, ty, tz] = backlogSlot(Math.min(i, 44));
    c.x = lerp(c.x, tx, k6); c.y = lerp(c.y, ty, k6); c.z = lerp(c.z, tz, k6);
  });
  G.crates = G.crates.filter(c => c.state !== 'done');
}

// ---------- tutorial (level 0) ----------
function tutorialStep(G) {
  const T = G.tut, items = G.L.items;
  if (T.idx < items.length && G.t >= T.nextT && !G.pendingModal && !T.waiting) {
    const it = items[T.idx];
    const c = newCrate(G, it.type);
    c.classified = false;
    addToBacklog(G, c);
    T.waiting = { c, it };
    G.pendingModal = { type: 'classify', item: it, idx: T.idx };
  }
}
function tutorialAnswer(G, type) {
  const T = G.tut, { c, it } = T.waiting;
  const ok = type === it.type;
  if (ok) T.correct++;
  // triage has stakes: a misread request lands in the wrong queue and someone waits
  patienceHit(G, ok ? 2 : -6, ok ? 'correct triage' : 'misrouted request');
  T.answers.push({ it, type, ok });
  c.classified = true;
  if (c.type === 'unp') {
    G.backlog.splice(G.backlog.indexOf(c), 1);
    c.loc = 4; c.released = G.t; c.state = 'fall';
    const p = slot(G.st[4], 0); c.x = p[0]; c.y = BELT_Y; c.z = 7; c.vz = 0;
    c.inc = newIncident(G, G.t);
    G.crates.push(c);
  }
  T.waiting = null; T.idx++; T.nextT = G.t + .7;
  return ok;
}

// ---------- KPIs ----------
function computeKpis(G) {
  const t = G.t, K = G.k || 1, W = 3 * K, win = Math.min(W, Math.max(t, .5));
  const del = G.stats.delivered.filter(d => !d.shadow);
  const recent = del.slice(-Math.round(10 * K * G.v));
  const thrN = del.filter(d => d.t > t - W).length;
  const res = G.stats.resolved.filter(r => r.t > t - W && !r.drill).length;
  const deps = G.stats.deploys;
  const last20 = deps.slice(-Math.round(20 * K * G.v));
  const visibleWip = G.crates.filter(c => c.loc >= 1 && c.loc <= 4 && !(c.shadow && !G.owned.kanban)).length;
  return {
    lead: recent.length ? avg(recent.map(d => d.lead)) : null,
    thr: thrN / win,
    wip: G.crates.filter(c => c.loc >= 1 && c.loc <= 4).length,
    wipVisible: visibleWip,
    unp: thrN + res ? res / (thrN + res) * 100 : 0,
    debt: G.debt,
    cfr: last20.length ? last20.filter(d => d.failed).length / last20.length * 100 : null,
    deploys: deps.filter(d => d.t > t - W).length / win,
    mttr: G.stats.mttr.length ? avg(G.stats.mttr.slice(-Math.round(5 * K * G.v))) : 0,
  };
}
function patienceHit(G, d, reason) {
  G.patience = clamp(G.patience + d, 0, 100);
  if (G.ghost || G.demo) return;
  const e = { d, reason, t: G.t };
  G.patFx.push(e); G.patLog.push(e);
}
function sampleKpis(G) {
  G.kpi = computeKpis(G);
  // queue history per station: lets the floor show where work is piling up right now
  G.qHist = G.qHist || [[], [], [], [], []];
  for (const s of G.st) { const h = G.qHist[s.i]; h.push(s.q.length + s.out.length); if (h.length > 60) h.shift(); }
  const vals = Object.assign({ patience: G.patience }, G.kpi);
  G.seriesT.push(G.t);
  for (const k of Object.keys(vals)) (G.series[k] = G.series[k] || []).push(vals[k]);
  if (G.demo && G.seriesT.length > 200) { G.seriesT.shift(); for (const k in G.series) G.series[k].shift(); }
  G.patLog = G.patLog.filter(e => G.t - e.t < 1);
}

// ---------- mentor ----------
function mentorSay(G, text, who) { if (!G.demo && !G.ghost) G.mentorQ.push({ text, who: who || 'mentor', t: G.t }); }

// Fog per station (0 clear … 1 thick). Asking around clears it briefly; the Kanban board lifts it for good.
function stationFog(G, i) {
  if (!G.L.fog || i < 1 || i > 4 || G.fogA <= 0) return 0;
  let a = 1;
  if (G.kanbanT != null) a = clamp(1 - ((G.t - G.kanbanT) * G.k - (i - 1) * .15) / .25, 0, 1);
  const p = G.peek[i];
  if (p && G.t < p.until) a *= 1 - .92 * clamp(Math.min((G.t - p.t0) * G.k / .12, (p.until - G.t) * G.k / .3), 0, 1);
  return a;
}
function peeking(G, i) { const p = G.peek[i]; return !!(p && G.t < p.until && G.kanbanT == null); }
function trigger(G, id, text) {
  if (G.fired.has(id)) return;
  G.fired.add(id);
  if ((G.L.generic || []).includes(id)) mentorSay(G, text);
}
