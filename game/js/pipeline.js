'use strict';
// Configurable pipelines: a structured document (see YOUR_FACTORY) describes intakes,
// stations and per-work-type routes. The engine lays the floor out, simulates the flow
// and draws it. Shifts 0-7 keep their hand-built factory; this powers sandbox shifts.
//
// Route grammar, per work type:
//   "A -> B"       one after the other
//   "A | B"        whichever of A or B has less load
//   "A?"           optional step (station.share = chance it is needed, default .5)
//   "{A, B, C}"    split an epic into parts for several teams; a station with join: true reunites them
//   "!expedite"    (at the end) this work jumps every queue
// A station of kind "backlog" has no people: teams pull work (and epic parts) from it when they have room.

const PIPE = { colW: 3.3, rowH: 2.45, left: 2.2 };
const STATION_TIME = { intake: 0, backlog: 0, refine: .5, triage: .15, design: .8, dev: 1, qa: .4, gate: .05, deploy: .04, env: .3 };

// ---------- parse & layout ----------
function parseRoute(str) {
  const expedite = /!expedite/.test(str);
  const steps = str.replace(/!expedite/, '').split('->').map(t => t.trim()).filter(Boolean).map(tok => {
    if (tok.startsWith('{')) return { kind: 'split', ids: tok.slice(1, -1).split(',').map(s => s.trim()) };
    if (tok.includes('|')) return { kind: 'any', ids: tok.split('|').map(s => s.trim()) };
    if (tok.endsWith('?')) return { kind: 'opt', ids: [tok.slice(0, -1).trim()] };
    return { kind: 'seq', ids: [tok] };
  });
  return { steps, expedite };
}

function compilePipeline(cfg) {
  const st = [], byId = {};
  const add = (id, def, kind) => {
    const s = {
      id, key: id, name: def.label || id, kind: def.kind || kind, def, i: st.length,
      q: [], out: [], rack: [], limit: null, u: 0, heroProb: 0, x: 0, y: 0, depth: 0,
    };
    const n = s.kind === 'intake' || s.kind === 'backlog' ? 0 : def.workers ?? (s.kind === 'gate' || s.kind === 'deploy' ? 1 : 2);
    s.workers = Array.from({ length: n }, (_, k) => ({ kind: 'normal', shirt: k, cur: null, timer: 0, dur: 0, u: 0 }));
    st.push(s); byId[id] = s;
  };
  for (const [id, def] of Object.entries(cfg.intakes || {})) add(id, def, 'intake');
  for (const [id, def] of Object.entries(cfg.stations || {})) add(id, def, def.kind || 'dev');
  const routes = {};
  for (const [type, r] of Object.entries(cfg.routes || {})) routes[type] = parseRoute(r);

  // depth = longest chain of steps leading to a station; intakes sit in column 0
  const edges = new Set();
  for (const [type, r] of Object.entries(routes)) {
    const intakeIds = Object.keys(cfg.intakes).filter(k => cfg.intakes[k].type === type);
    let prev = intakeIds;
    for (const step of r.steps) {
      for (const p of prev) for (const n of step.ids) edges.add(p + '>' + n);
      prev = step.kind === 'opt' ? [...prev, ...step.ids] : step.ids;
    }
    for (const p of prev) edges.add(p + '>__customers');
  }
  const E = [...edges].map(e => e.split('>'));
  // columns follow the longest route first; later routes only place stations not seen yet,
  // so a route that goes "backwards" (e.g. QA handing bugfixes to Dev) can't stretch the floor
  const placed = new Set(st.filter(s => s.kind === 'intake').map(s => s.id));
  const order = Object.entries(routes).sort((a, b) => b[1].steps.length - a[1].steps.length);
  for (const [, r] of order) {
    let prev = 0;
    for (const step of r.steps) {
      for (const id of step.ids) {
        const s = byId[id];
        if (s && !placed.has(id)) { s.depth = prev + 1; placed.add(id); }
      }
      const ds = step.ids.map(id => byId[id] ? byId[id].depth : prev);
      prev = step.kind === 'opt' ? Math.max(prev, ...ds) : Math.max(...ds);
    }
  }
  // close gaps so every used depth becomes one column
  const used = [...new Set(st.map(s => s.depth))].sort((a, b) => a - b);
  for (const s of st) s.depth = used.indexOf(s.depth);
  const maxDepth = used.length - 1;
  const cols = used.map(() => []);
  for (const s of st) cols[s.depth].push(s);
  const rows = Math.max(...cols.map(c => c.length));
  const GHp = Math.max(7, rows * PIPE.rowH + 1.8);
  for (const col of cols) col.forEach((s, k) => {
    s.x = PIPE.left + s.depth * PIPE.colW;
    s.y = GHp / 2 - .6 + (k - (col.length - 1) / 2) * PIPE.rowH;
    s.prect = [s.x - 1.05, s.y - .85, s.x + 1.05, s.y + .85];
  });
  const custX = PIPE.left + (maxDepth + 1) * PIPE.colW;
  return {
    st, byId, routes, edges: E, custX, custY: GHp / 2 - .6,
    GW: Math.ceil(custX + 2.4), GH: Math.ceil(GHp),
    feedback: cfg.feedback && cfg.feedback.escapedDefects,
  };
}

// ---------- game ----------
function newPipelineGame(L, opts = {}) {
  const seed = opts.seed ?? (Math.random() * 4294967296) >>> 0;
  const rng = mulberry32(seed);
  const P0 = compilePipeline(L.pipeline);
  const G = {
    L, t: 0, k: 1, v: 1, speed: 1, ended: null, seed, rng, pipe: P0, st: P0.st,
    crates: [], backlog: [], sparks: [], flashes: [], pulses: [], patience: L.patience ?? 70, budget: 0,
    debt: 0, debtShare: 0, fq: 1, batch: 1, flags: {}, owned: { kanban: true }, locks: {},
    toolUses: {}, decisions: [], choices: {}, patFx: [], patLog: [], patDrain: { incidents: 0, backlog: 0, wip: 0, debt: 0 },
    stats: { delivered: [], resolved: [], deploys: [], mttr: [], reworks: 0, interruptions: 0 },
    incidents: [], pending: [], mentorQ: [], fired: new Set(), events: [], schedule: [], kpi: {}, series: {}, seriesT: [],
    sampleT: 0, pendingModal: null, steps: {}, tut: {}, peek: {}, peeked: new Set(), disc: {}, seen: {}, fogA: 0, kanbanT: null,
    hero: { x: -99, y: -99, path: [], state: 'home', doc: null, otUntil: -1, burnUntil: -1, errandUntil: -1 },
    arrive: {}, epicN: 0, returns: [],
  };
  for (const s of G.st) if (s.kind === 'intake') G.arrive[s.id] = withRng(rng, () => rnd(0, 1 / (s.def.rate || 1)));
  return G;
}

function pipeLoad(s) { return s.q.length + s.workers.filter(w => w.cur).length; }
function stationTime(G, s, c) {
  const d = s.def, base = (d.times && d.times[c.type]) ?? d.time ?? STATION_TIME[s.kind] ?? .5;
  return base * (c.epic && c.part ? 1 : 1) * rnd(.75, 1.25) * (c.rework ? .5 : 1);
}

// Decide where a crate goes after finishing (or entering at) step c.si.
function routeNext(G, c, from) {
  const P0 = G.pipe, r = P0.routes[c.type];
  while (true) {
    c.si++;
    const step = r.steps[c.si];
    if (!step) return sendTo(G, c, from, null);
    if (step.kind === 'opt') {
      const s = P0.byId[step.ids[0]];
      if (rand() > (s.def.share ?? .5)) continue;
      return sendTo(G, c, from, s);
    }
    if (step.kind === 'any') {
      const opts = step.ids.map(id => P0.byId[id]).filter(Boolean);
      opts.sort((a, b) => pipeLoad(a) / Math.max(1, a.workers.length) - pipeLoad(b) / Math.max(1, b.workers.length));
      return sendTo(G, c, from, opts[0]);
    }
    if (step.kind === 'split') {
      let parts = step.ids.map(id => P0.byId[id]).filter(s => s && rand() < (s.def.share ?? .7));
      if (!parts.length) parts = [P0.byId[step.ids[0]]];
      const epic = { id: ++G.epicN, n: parts.length, arrived: [], released: c.released };
      c.state = 'done';
      parts.forEach(s => {
        const p = pipeCrate(G, c.type, c.released);
        Object.assign(p, { epic, part: true, si: c.si, x: c.x, y: c.y, z: c.z, defect: false });
        G.crates.push(p);
        sendTo(G, p, from, s);
      });
      return;
    }
    return sendTo(G, c, from, P0.byId[step.ids[0]]);
  }
}

function pipeCrate(G, type, released) {
  return { id: ++crateId, type, classified: true, loc: -1, si: -1, state: 'move', x: 0, y: 0, z: .12, path: [],
    born: G.t, released: released ?? G.t, defect: false, rework: false, w: null };
}

// Belt path from a station's output to the next station's queue: across, down/up, across.
function sendTo(G, c, from, to) {
  const P0 = G.pipe;
  const fx = from ? from.x + 1.15 : c.x, fy = from ? from.y : c.y;
  const tx = to ? to.x - 1.35 : P0.custX - .4, ty = to ? to.y : P0.custY;
  const mx = Math.min(tx - .5, fx + PIPE.colW / 2 - .6);
  c.path = [[fx, fy], [mx, fy], [mx, ty], [tx, ty]];
  c.dest = to; c.loc = to ? to.i : -2; c.state = 'move'; c.w = null; c.z = .2;
  if (from) { c.x = fx; c.y = fy; }
}

function arrivePipe(G, c) {
  const s = c.dest;
  if (!s) return deliverPipe(G, c);
  if (s.def.join && c.epic && c.part) {
    // join: epic parts wait on the rack until the whole epic is there
    c.state = 'rack'; s.rack.push(c);
    c.epic.arrived.push(c);
    if (c.epic.arrived.length === c.epic.n) {
      const parts = c.epic.arrived;
      s.rack = s.rack.filter(x => !parts.includes(x));
      parts.forEach(x => { x.state = 'done'; });
      const m = pipeCrate(G, c.type, c.epic.released);
      Object.assign(m, { big: true, epicDone: true, epicN: c.epic.n, si: c.si, lastDev: c.lastDev, x: c.x, y: c.y, defect: parts.some(x => x.defect), state: 'queue', loc: s.i, dest: s });
      G.crates.push(m); s.q.push(m);
    }
    return;
  }
  c.state = 'queue'; c.qAt = G.t;
  if (G.pipe.routes[c.type].expedite) {
    const k = s.q.findIndex(x => !G.pipe.routes[x.type].expedite);
    s.q.splice(k < 0 ? s.q.length : k, 0, c);
  } else s.q.push(c);
}

// Teams pull from the backlog only when they have room; epics turn into parts here.
function hasRoom(s) { return s.q.length + s.workers.filter(w => w.cur).length < s.workers.length + (s.def.buffer ?? 1); }
function epicParts(G, c, step) {
  let teams = step.ids.map(id => G.pipe.byId[id]).filter(s => s && rand() < (s.def.share ?? .7));
  if (!teams.length) teams = [G.pipe.byId[step.ids[0]]];
  const epic = { id: ++G.epicN, n: teams.length, arrived: [], released: c.released };
  return teams.map(team => {
    const p = pipeCrate(G, c.type, c.released);
    return Object.assign(p, { epic, part: true, team, x: c.x, y: c.y, z: c.z, state: 'queue', loc: c.loc });
  });
}
function pullFromBacklog(G, s) {
  const R = G.pipe.routes;
  for (let k = 0; k < s.q.length;) {
    const c = s.q[k], idx = c.si + 1, step = R[c.type].steps[idx];
    if (!step) { s.q.splice(k, 1); routeNext(G, c, s); continue; }
    if (step.kind === 'split' && !c.part) {
      const parts = epicParts(G, c, step);
      parts.forEach(p => { p.si = idx; G.crates.push(p); });
      c.state = 'done';
      s.q.splice(k, 1, ...parts);
      continue;
    }
    let cands = c.part ? [c.team] : step.ids.map(id => G.pipe.byId[id]).filter(Boolean);
    if (step.kind === 'opt' && !c.part) {
      if (c.optSkip == null) c.optSkip = rand() > (cands[0].def.share ?? .5);
      if (c.optSkip) { c.si = idx; c.optSkip = null; continue; }
    }
    const free = cands.filter(hasRoom).sort((a, b) => pipeLoad(a) / Math.max(1, a.workers.length) - pipeLoad(b) / Math.max(1, b.workers.length));
    if (!free.length) { k++; continue; }
    s.q.splice(k, 1);
    if (!c.part) c.si = idx;
    sendTo(G, c, s, free[0]);
  }
}

function finishPipe(G, s, w) {
  const c = w.cur; w.cur = null;
  const d = s.def;
  if (s.kind === 'dev' || s.kind === 'design') {
    if (s.kind === 'dev') c.defect = rand() < (d.defectRate ?? .12) * (c.rework ? .3 : 1);
    c.lastDev = s;
  }
  // gatekeepers: some work is sent back (rejectTo a station) or dropped (rejectTo "drop")
  const rr = (d.rejectRates && d.rejectRates[c.type]) ?? (d.rejectRate ?? 0);
  if (rr && rand() < rr * (c.rejected ? .4 : 1)) {
    c.rejected = true;
    if (d.rejectTo === 'drop') {
      c.state = 'done'; G.stats.dropped = (G.stats.dropped || 0) + 1;
      spark(G, s.x, s.y, .6, PAL.gray, 6);
      return;
    }
    const back = G.pipe.byId[d.rejectTo] || G.st.find(x => x.kind === 'intake' && x.def.type === c.type);
    const idx = G.pipe.routes[c.type].steps.findIndex(st => st.ids.includes(back.id));
    c.si = idx; // the station it goes back to continues the route from there
    if (back.kind === 'intake') { c.si = -1; c.backToIntake = true; }
    sendTo(G, c, s, back);
    return;
  }
  if (s.kind === 'qa' && c.defect && rand() < (d.detect ?? .6)) {
    c.defect = false; G.stats.reworks++;
    c.rework = true; w.cur = c; w.dur = w.timer = stationTime(G, s, c) * .6; // fix it on the spot
    return;
  }
  if (s.kind === 'gate') {
    const fail = (c.defect && rand() < .8) || rand() < (d.failRate ?? 0) * .3;
    G.flashes.push({ x: s.x, y: s.y, z: 1.6, t0: G.t, col: fail ? PAL.bad : PAL.good });
    if (fail && c.lastDev) {
      c.rework = true; c.defect = rand() < .3 && c.defect; G.stats.reworks++;
      // send it back to the team that built it
      c.si = G.pipe.routes[c.type].steps.findIndex(st => st.ids.includes(c.lastDev.id));
      sendTo(G, c, s, c.lastDev);
      return;
    }
  }
  if (s.kind === 'deploy') G.stats.deploys.push({ t: G.t, n: 1, failed: !!c.defect });
  routeNext(G, c, s);
}

function deliverPipe(G, c) {
  c.state = 'done';
  G.stats.delivered.push({ t: G.t, lead: G.t - c.released, type: c.type, epic: !!c.epicDone });
  spark(G, G.pipe.custX + .3, G.pipe.custY + .15, .4, PAL.crate[c.type]);
  if (c.defect && G.pipe.feedback) {
    // a defect escaped to the field: it comes back as urgent work
    const back = G.pipe.byId[G.pipe.feedback];
    if (back) G.returns.push({ at: G.t + rnd(.5, 1.5), to: back, x: G.pipe.custX, p: 0 });
  }
}

function pipelineUpdate(G, dt) {
  G.t += dt;
  const P0 = G.pipe;
  // arrivals at each intake
  for (const s of G.st) {
    if (s.kind !== 'intake') continue;
    G.arrive[s.id] -= dt;
    while (G.arrive[s.id] <= 0) {
      G.arrive[s.id] += (1 / (s.def.rate || 1)) * rnd(.6, 1.4);
      const c = pipeCrate(G, s.def.type);
      c.loc = s.i; c.state = 'intake'; c.x = s.x - .5; c.y = s.y; c.z = 1.5; c.big = c.type === 'biz';
      s.q.push(c); G.crates.push(c);
    }
  }
  // intakes push work on immediately (sandbox: no release policy yet)
  for (const s of G.st) {
    if (s.kind !== 'intake' || !s.q.length) continue;
    s.relCd = (s.relCd || 0) - dt;
    if (s.relCd > 0) continue;
    const c = s.q.shift();
    if (c.backToIntake) { c.backToIntake = false; c.si = -1; }
    c.released = c.rejected ? c.released : G.t;
    routeNext(G, c, s);
    s.relCd = .08;
  }
  // escaped defects travel back along the return belt
  for (let k = G.returns.length - 1; k >= 0; k--) {
    const r = G.returns[k];
    if (G.t >= r.at) {
      G.returns.splice(k, 1);
      const c = pipeCrate(G, r.to.def.type || 'unp');
      c.loc = r.to.i; c.state = 'intake'; c.x = r.to.x; c.y = r.to.y; c.z = 2;
      r.to.q.push(c); G.crates.push(c);
    }
  }
  // stations
  for (const s of G.st) {
    if (s.kind === 'intake') continue;
    if (s.kind === 'backlog') { pullFromBacklog(G, s); continue; }
    for (const w of s.workers) {
      w.u += ((w.cur ? 1 : 0) - w.u) * Math.min(1, dt);
      if (w.cur) {
        w.timer -= dt;
        if (w.timer <= 0) finishPipe(G, s, w);
        continue;
      }
      const c = s.q.shift();
      if (c) { c.state = 'proc'; c.w = w; w.cur = c; w.dur = w.timer = stationTime(G, s, c); }
    }
    s.u = s.workers.length ? s.workers.reduce((a, w) => a + w.u, 0) / s.workers.length : 0;
  }
  movePipeCrates(G, dt);
  G.crates = G.crates.filter(c => c.state !== 'done');
  for (const p of G.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vz -= 380 * dt; p.life -= dt; }
  G.sparks = G.sparks.filter(p => p.life > 0);
  G.flashes = G.flashes.filter(f => G.t - f.t0 < .25);
  G.sampleT -= dt;
  if (G.sampleT <= 0) { G.sampleT = .25; sampleKpis(G); }
}

const PIPE_SPEED = 14;
function pipeSlot(s, k) {
  // queue pile in front of the station: 2 rows deep, stacked 3 high, growing to the left
  const col = Math.floor(k / 6), r = k % 6, row = r % 2, layer = Math.floor(r / 2);
  return [s.x - 1.45 - col * .34, s.y - .35 + row * .38, .12 + layer * .3];
}
function movePipeCrates(G, dt) {
  const kk = Math.min(1, dt * 45);
  for (const c of G.crates) {
    if (c.state === 'move') {
      let d = PIPE_SPEED * dt;
      while (d > 0 && c.path.length) {
        const [tx, ty] = c.path[0], dx = tx - c.x, dy = ty - c.y, L = Math.hypot(dx, dy);
        if (L <= d) { c.x = tx; c.y = ty; c.path.shift(); d -= L; } else { c.x += dx / L * d; c.y += dy / L * d; d = 0; }
      }
      c.z = lerp(c.z, .2, kk);
      if (!c.path.length) arrivePipe(G, c);
    }
  }
  for (const s of G.st) {
    s.q.forEach((c, k) => {
      const [tx, ty, tz] = s.kind === 'intake' ? [s.x - .55 + (k % 3) * .36, s.y - .4 + (Math.floor(k / 3) % 3) * .36, .12 + Math.floor(k / 9) * .3]
        : s.kind === 'backlog' ? [s.x - .85 + (k % 6) * .32, s.y - .7 + (Math.floor(k / 6) % 4) * .36, .14 + Math.floor(k / 24) * .26] : pipeSlot(s, k);
      c.x = lerp(c.x, tx, kk); c.y = lerp(c.y, ty, kk); c.z = lerp(c.z, tz, kk);
    });
    s.rack.forEach((c, k) => {
      const tx = s.x + .55 - (k % 4) * .32, ty = s.y - .75, tz = .5 + Math.floor(k / 4) * .32;
      c.x = lerp(c.x, tx, kk); c.y = lerp(c.y, ty, kk); c.z = lerp(c.z, tz, kk);
    });
    s.workers.forEach((w, k) => {
      if (!w.cur) return;
      const sp = workerSlot(s, k);
      w.cur.x = lerp(w.cur.x, sp.x - .15, kk); w.cur.y = lerp(w.cur.y, sp.y + .35, kk); w.cur.z = lerp(w.cur.z, .5, kk);
    });
  }
}

// people on a platform: up to 6 are drawn, the rest work "off screen"
function workerSlot(s, k) {
  const n = Math.min(6, s.workers.length), perRow = Math.min(3, n), row = Math.floor(Math.min(k, 5) / 3), col = Math.min(k, 5) % 3;
  const span = perRow > 1 ? 1.2 / (perRow - 1) : 0;
  return { x: s.x - (perRow > 1 ? .6 : 0) + col * span, y: s.y - .15 + row * .55, hidden: k >= 6 };
}

function pipelineKpis(G) {
  const t = G.t, win = Math.min(3, Math.max(t, .5));
  const del = G.stats.delivered, recent = del.slice(-10), last3 = del.filter(d => d.t > t - 3);
  const floor = G.crates.filter(c => c.loc >= 0 && G.st[c.loc] && G.st[c.loc].kind !== 'intake' || c.state === 'move' || c.state === 'rack');
  return {
    lead: recent.length ? avg(recent.map(d => d.lead)) : null,
    thr: last3.length / win,
    wip: floor.length,
    unp: last3.length ? last3.filter(d => d.type === 'unp').length / last3.length * 100 : 0,
    debt: 0, cfr: null, deploys: 0, mttr: 0,
  };
}

// ---------- drawing ----------
function drawPipeline(G, ui) {
  const T = G.t * DAY_SEC, P0 = G.pipe;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const k = VIEW.dpr * VIEW.scale;
  ctx.setTransform(k, 0, 0, k, VIEW.dpr * VIEW.ox, VIEW.dpr * VIEW.oy);
  box(0, 0, -.5, GW, GH, .5, PAL.slab);
  for (let i = 0; i < GW; i++) for (let j = 0; j < GH; j++)
    poly([P(i, j, 0), P(i + 1, j, 0), P(i + 1, j + 1, 0), P(i, j + 1, 0)], (i + j) % 2 ? PAL.floorA : PAL.floorB);

  // belts between stations (drawn once per connection)
  ctx.lineCap = 'round';
  const seen = new Set();
  for (const [a, b] of P0.edges) {
    const A = P0.byId[a], B = b === '__customers' ? null : P0.byId[b];
    if (!A || seen.has(a + b)) continue;
    seen.add(a + b);
    const fx = A.x + 1.15, fy = A.y, tx = B ? B.x - 1.35 : P0.custX - .4, ty = B ? B.y : P0.custY;
    const mx = Math.min(tx - .5, fx + PIPE.colW / 2 - .6);
    beltLine([[fx, fy], [mx, fy], [mx, ty], [tx, ty]]);
  }
  if (P0.feedback && P0.byId[P0.feedback]) {
    const F = P0.byId[P0.feedback], yb = GH - .55;
    beltLine([[P0.custX + .2, P0.custY + .8], [P0.custX + .2, yb], [F.x - 1.6, yb], [F.x - 1.6, F.y + .9]], PAL.crate.unp);
  }
  // selection / hover rings
  for (const s of G.st) {
    const [x0, y0, x1, y1] = s.prect;
    box(x0, y0, 0, x1 - x0, y1 - y0, .12, PAL.platform);
    if (ui.hover === s.i || ui.selected === s.i) floorOutline(x0 - .08, y0 - .08, x1 + .08, y1 + .08, .13, PAL.select, 2.5);
  }
  // queue heat under piles
  for (const s of G.st) {
    if (s.kind === 'intake' || s.kind === 'backlog' || s.q.length < 3) continue;
    const heat = clamp((s.q.length - 2) / 10, 0, 1), cols = Math.ceil(s.q.length / 6);
    const col = heat > .55 ? '255,70,90' : '255,190,70';
    poly([P(s.x - 1.2 - cols * .34, s.y - .45, .02), P(s.x - 1.15, s.y - .45, .02), P(s.x - 1.15, s.y + .45, .02), P(s.x - 1.2 - cols * .34, s.y + .45, .02)],
      `rgba(${col},${.3 + .35 * heat})`);
  }

  const D = [], add = (key, f) => D.push({ key, f });
  for (const s of G.st) {
    const { x, y } = s;
    if (s.kind === 'intake') {
      add(x + y - .6, () => { box(x + .35, y - .6, .12, .5, 1.2, .9, PAL.machine); frontQuad(x + .38, x + .82, y + .6, .45, .8, PAL.crate[s.def.type] || PAL.gray, true); });
    } else if (s.kind === 'gate') {
      // automated check: an arch with a status light
      const busy = s.workers.some(w => w.cur), last = G.flashes.filter(f => Math.abs(f.x - x) < .01).pop();
      add(x + y - .3, () => {
        box(x - .5, y - .6, .12, .18, .18, 1.25, PAL.machine);
        box(x - .5, y + .42, .12, .18, .18, 1.25, PAL.machine);
        box(x - .55, y - .6, 1.37, .28, 1.2, .2, PAL.machine);
        const col = last ? last.col : busy ? PAL.select : PAL.track;
        box(x - .48, y - .1, 1.57, .16, .2, .12, col, true);
      });
    } else if (s.kind === 'deploy') {
      add(x + y - .5, () => {
        box(x - .35, y - .55, .12, .7, .55, .8, PAL.machine);
        for (let k2 = 0; k2 < 4; k2++) frontQuad(x - .3 + k2 * .16, x - .2 + k2 * .16, y, .55, .65, Math.sin(T * 6 + k2) > 0 ? PAL.good : PAL.track, true);
      });
    } else if (s.kind === 'qa') {
      add(x + y - .9, () => { box(x - .8, y - .85, .12, 1.6, .25, .3, PAL.desk); box(x - .8, y - .85, .45, 1.6, .25, .05, PAL.desk); });
    }
    if (s.kind === 'backlog') add(x + y - .9, () => box(x - .95, y - .85, .12, 1.9, .12, .7, PAL.machine));
    if (s.kind !== 'intake' && s.kind !== 'gate' && s.kind !== 'deploy' && s.kind !== 'backlog') {
      add(x + y + .05, () => box(x - .75, y + .15, .12, 1.5, .35, .34, PAL.desk));
      s.workers.forEach((w, k2) => {
        const sp = workerSlot(s, k2);
        if (sp.hidden) return;
        add(sp.x + sp.y + .5, () => person(sp.x, sp.y + .55, .12, { shirt: PAL.shirts[k2 % 4], bob: w.cur ? Math.abs(Math.sin(T * 9 + k2)) * .03 : 0 }));
      });
    }
  }
  for (const c of G.crates) add(c.x + c.y + .3 + c.z * .05, () => drawCrate(G, c, T));
  for (const r of G.returns) {
    const p = clamp(1 - (r.at - G.t) / 1.2, 0, 1), F = r.to, yb = GH - .55;
    const x = lerp(P0.custX + .2, F.x - 1.6, p);
    add(x + yb, () => { box(x, yb - .15, .2, .3, .3, .3, PAL.crate.unp, true); flame(x + .15, yb, .5, T, 1); });
  }
  add(P0.custX + P0.custY + 1, () => { house(P0.custX + .2, P0.custY - 1.6, false, T); house(P0.custX + .5, P0.custY + .3, false, T); });
  D.sort((a, b) => a.key - b.key);
  for (const d of D) d.f();

  // sparks and labels
  for (const p of G.sparks) { const [sx, sy] = P(p.x, p.y, p.z); ctx.fillStyle = p.col; ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3); }
  for (const s of G.st) {
    const [sx, sy] = P(s.x, s.y - .3, 2.2);
    if (s.kind !== 'intake' && s.kind !== 'backlog') {
      const u = s.u, col = u < .7 ? PAL.good : u < .9 ? PAL.warn : PAL.bad;
      ctx.lineWidth = 4; ctx.strokeStyle = PAL.track;
      ctx.beginPath(); ctx.arc(sx, sy - 22, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(sx, sy - 22, 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * u); ctx.stroke();
      ctx.fillStyle = PAL.text; ctx.font = '700 9px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(u * 100) + '%', sx, sy - 21.5);
    }
    const n = s.workers.length;
    pill(s.name + (n > 6 ? ` · ${n} people` : '') + (s.kind === 'backlog' ? ` · ${s.q.length} items` : ''), sx, sy + 4, s.kind === 'backlog' && s.q.length > 20 ? PAL.warn : null, s.kind === 'backlog' && s.q.length > 20 ? '#2a2108' : null);
    if (s.kind === 'refine') {
      const epics = s.q.length + s.workers.filter(w => w.cur).length;
      if (epics) { const [ex, ey] = P(s.x + .3, s.y + 1.1, .25); pill(`${epics} epic${epics > 1 ? "s" : ""} here`, ex, ey, PAL.crate.biz); }
    }
    const waiting = s.q.length;
    if (s.kind !== 'intake' && s.kind !== 'backlog' && s.kind !== 'refine' && waiting >= 4) {
      const [qx, qy] = P(s.x - 1.6, s.y, 1.5);
      pill(`${waiting} waiting`, qx, qy, waiting >= 10 ? PAL.bad : PAL.warn, waiting >= 10 ? '#ffffff' : '#2a2108');
    }
    if (s.rack.length) {
      const epics = new Set(s.rack.map(c => c.epic.id)).size;
      const [rx, ry] = P(s.x + .2, s.y - .9, 1.9);
      pill(`${epics} epic${epics > 1 ? 's' : ''} waiting for parts`, rx, ry, PAL.crate.biz);
    }
  }
  const [cx, cy] = P(P0.custX + .4, P0.custY - .4, 2.2);
  pill('Customers', cx, cy);
}

function beltLine(pts, tint) {
  ctx.strokeStyle = PAL.belt; ctx.lineWidth = 11; ctx.lineJoin = 'round';
  ctx.beginPath(); pts.forEach((p, i) => { const [sx, sy] = P(p[0], p[1], .14); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.stroke();
  ctx.strokeStyle = tint ? mix(tint, PAL.belt, .55) : PAL.stripe; ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
  ctx.beginPath(); pts.forEach((p, i) => { const [sx, sy] = P(p[0], p[1], .15); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.stroke();
  ctx.setLineDash([]);
}

// ---------- your factory ----------
const YOUR_FACTORY = {
  name: 'Your Factory',
  intakes: {
    Market: { label: 'Market & stakeholders', type: 'biz', rate: 1.35 },
    Internal: { label: 'Internal projects', type: 'int', rate: .3 },
    Changes: { label: 'Changes & bugfixes', type: 'chg', rate: 1.4 },
    Urgent: { label: 'Urgent from the field', type: 'unp', rate: .25 },
  },
  routes: {
    biz: 'PdM -> RA -> Backlog -> {UIUX, Core, WebBackend, DevOps} -> CI -> Release',
    int: 'Backlog -> DevOps | Core -> CI -> Release',
    chg: 'QA -> Backlog -> Core | WebBackend -> CI -> Release',
    unp: 'QA -> Core | WebBackend | DevOps -> CI -> Release !expedite',
  },
  stations: {
    PdM: { kind: 'refine', label: 'Product management', workers: 3, time: 1.2 },
    RA: { kind: 'refine', label: 'Process Masters', workers: 4, time: 1.5, rejectRate: .2, rejectTo: 'PdM' },
    QA: { kind: 'triage', label: 'QA gate', workers: 2, time: .2, times: { unp: .02 }, rejectRates: { chg: .2 }, rejectTo: 'drop' },
    Backlog: { kind: 'backlog', label: 'Project backlog' },
    UIUX: { kind: 'dev', label: 'UI/UX', workers: 1, time: 1.2, share: .5, defectRate: .05 },
    Core: { kind: 'dev', label: 'Core', workers: 12, time: 6, share: .9, times: { chg: .8, unp: .5, int: 2 } },
    WebBackend: { kind: 'dev', label: 'Web / Backend', workers: 4, time: 4.5, share: .7, times: { chg: .8, unp: .5 } },
    DevOps: { kind: 'dev', label: 'DevOps', workers: 5, time: 3, share: .4, times: { int: 2, unp: .5 } },
    CI: { kind: 'gate', label: 'CI/CD → main', time: .05, failRate: .1 },
    Release: { kind: 'deploy', label: 'Release', time: .04, join: true },
  },
  feedback: { escapedDefects: 'Urgent' },
};

// Shift 8: a sandbox that runs whatever pipeline document is loaded (your factory by default).
LEVELS.push({
  id: 8, title: 'Your Factory', concept: 'Sandbox: your own pipeline', sandbox: true,
  hook: 'Your own value stream, built from a pipeline document. No targets, no traps yet: watch where work piles up, how epics wait for their slowest part, and what escapes to the field.',
  learn: ['See your real flow', 'Spot where epics wait for each other', 'Find your constraint'],
  days: 1e9, patience: 100, pipeline: YOUR_FACTORY,
  kpis: ['lead', 'thr', 'wip', 'unp'], tools: [], goals: [],
  mentor: [
    { id: 'a', when: G => G.t > .6, text: 'This is your factory, drawn from a document. Click any station to inspect it. Where does work wait longest?' },
    { id: 'b', when: G => G.st.some(s => s.rack && s.rack.length >= 4), text: 'Look at Release: finished parts sitting on the rack, waiting for the rest of their epic. Which team is everybody waiting for?' },
  ],
  hints: ['Piles in front of a station mean it is the constraint, or close to it.', 'Epics finish only when their slowest part is done.'],
  insight: {
    title: 'Your Value Stream',
    body: 'Every factory has the same physics: work waits in front of the constraint, big batches wait for their slowest part, and escaped defects come back as unplanned work.',
    formula: 'Lead time ≈ WIP ÷ Throughput, in every pipeline',
  },
});

// ---------- loading your own pipeline document ----------
function setPipeline(cfg) {
  compilePipeline(cfg); // throws on a broken document before anything changes
  LEVELS.find(l => l.id === 8).pipeline = cfg;
}
function applySavedPipeline() {
  try { if (UI.save.pipeline) setPipeline(JSON.parse(UI.save.pipeline)); } catch { delete UI.save.pipeline; }
}
function showPipelineLoader() {
  const cur = JSON.stringify(LEVELS.find(l => l.id === 8).pipeline, null, 2);
  const card = openModal(`
    <div class="eyebrow">Sandbox · shift 8</div>
    <h2>Load your pipeline</h2>
    <p class="muted" style="font-size:13px">Describe intakes, stations and the route each type of work takes. Routes: <code>A -> B</code> in order,
      <code>A | B</code> either one, <code>A?</code> optional, <code>rejectTo</code> a station or <code>"drop"</code> for gatekeepers, <code>{A, B}</code> split an epic into parts (the next station joins them), <code>!expedite</code> jumps queues.
      Station kinds: <code>refine</code>, <code>triage</code>, <code>backlog</code> (teams pull from it), <code>dev</code>, <code>gate</code>, <code>deploy</code>; <code>join: true</code> reunites epic parts.</p>
    <textarea id="pipeText" class="pipe-text" spellcheck="false">${esc(cur)}</textarea>
    <div id="pipeErr" class="feedback no hidden"></div>
    <div class="modal-actions">
      <label class="btn">Open file…<input type="file" id="pipeFile" accept=".json,application/json" hidden></label>
      <button class="btn" data-reset>Example</button>
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-go>Build and start</button>
    </div>`, true);
  const ta = card.querySelector('#pipeText'), err = card.querySelector('#pipeErr');
  card.querySelector('#pipeFile').onchange = e => { const f = e.target.files[0]; if (f) f.text().then(t => { ta.value = t; }); };
  card.querySelector('[data-reset]').onclick = () => { ta.value = JSON.stringify(YOUR_FACTORY, null, 2); };
  card.querySelector('[data-close]').onclick = closeModal;
  card.querySelector('[data-go]').onclick = () => {
    try {
      const cfg = JSON.parse(ta.value);
      setPipeline(cfg);
      UI.save.pipeline = JSON.stringify(cfg); persist();
      closeModal(); startLevel(LEVELS.findIndex(l => l.id === 8));
    } catch (e) {
      err.textContent = 'That document doesn\'t work yet: ' + e.message;
      err.classList.remove('hidden');
    }
  };
}
