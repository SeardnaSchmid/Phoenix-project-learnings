'use strict';
// Game content: KPIs, tools (incl. traps) and the seven levels.

const KPI_META = {
  lead: { label: 'Lead time', unit: 'days', fmt: v => v.toFixed(1), color: 'biz',
    info: 'Time from starting an item to delivering it.<br><b>Little\'s Law:</b> lead time ≈ WIP ÷ throughput. Less WIP means shorter lead time.' },
  thr: { label: 'Throughput', unit: '/ day', fmt: v => v.toFixed(1), color: 'int',
    info: 'Items delivered per day (last 3 days).<br>Only the <b>constraint</b> sets throughput. Improving anything else doesn\'t raise it.' },
  wip: { label: 'Work in progress', unit: 'items', fmt: v => String(Math.round(v)), color: 'chg',
    info: 'Everything started but not finished.<br>Invisible WIP is the silent killer: every extra item makes all others wait longer.' },
  unp: { label: 'Unplanned work', unit: '%', fmt: v => String(Math.round(v)), color: 'unp',
    info: 'Share of finished work that was firefighting (last 3 days).<br>Unplanned work is <b>anti-work</b>: it silently displaces all planned work.' },
  debt: { label: 'Tech debt', unit: 'pts', fmt: v => String(Math.round(v)), color: 'unp',
    info: 'Grows with every feature built on shortcuts, shrinks with internal improvement work.<br>High debt keeps spawning fires.' },
  cfr: { label: 'Change fail rate', unit: '%', fmt: v => String(Math.round(v)), color: 'unp',
    info: 'Share of the last 20 deployments that caused an incident.<br>Fewer failures come from risk-focused review and quality built in, not from more approvals.' },
  deploys: { label: 'Deploy frequency', unit: '/ day', fmt: v => v.toFixed(1), color: 'int',
    info: 'Deployments per day (last 3 days).<br>Small, frequent deploys mean less risk per deploy and faster feedback.' },
  mttr: { label: 'Time to restore', unit: 'days', fmt: v => v.toFixed(2), color: 'biz',
    info: 'Mean time from customer impact to fix (last 5 incidents).<br>Fast feedback and practice shorten it.' },
};

const TYPE_INFO = {
  biz: { name: 'Business project', desc: 'New features and initiatives the business asked for.' },
  int: { name: 'Internal IT project', desc: 'Improvements to IT itself: infrastructure, automation, paying down debt.' },
  chg: { name: 'Change', desc: 'Updates to running systems: patches, config, releases.' },
  unp: { name: 'Unplanned work', desc: 'Incidents and fires. It jumps the queue and displaces everything else.' },
};

// Diagnosis for "Too Much Stuff": the wait-time curve, read at the busiest point.
function waitInfo(G, i) {
  const s = G.st[i], u = s.u;
  if (u < .8) return { html: `At ${Math.round(u * 100)}% busy, waits here stay short. Some slack is healthy.` };
  const mult = u >= .99 ? 'endless' : `about ${(u / (1 - u)).toFixed(0)}×`;
  return { seen: 'waitCurve', html: `<b>${Math.round(u * 100)}% busy</b>: every item waits ${mult} as long as the actual work takes. Look at the curve: near 100% it goes vertical.` };
}
// Diagnosis for "Fires": where fires come from, and how late you notice them.
function fireInfo(G, i) {
  const n = G.crates.filter(c => c.loc === i && c.type === 'unp').length;
  if (!n) return null;
  return { seen: 'fireCause', html: `<b>${n} fire${n > 1 ? 's' : ''}</b> here. They come from old shortcuts in the code: tech debt is at <b>${Math.round(G.debt)}</b>, and every rushed feature adds more.` };
}
function detectInfo(G) {
  const inc = G.incidents.filter(x => !x.drill && x.start <= G.t);
  if (!inc.length) return { html: 'No customer-facing incident yet. When one happens, look here: how long until anyone noticed?' };
  const late = detectDelay(G);
  return { seen: G.fq < .9 ? 'lateDetect' : null, html: G.fq >= .9 ? 'Monitoring spots incidents within minutes now.'
    : `The last outage was noticed <b>${late.toFixed(1)} days</b> after it started, when customers called. Until then, nobody even knew.` };
}

// Diagnosis for "The Hero": items at a station that only the hero can do.
function heroWaitInfo(G, i) {
  const s = G.st[i], n = s.q.filter(c => c.needsHero).length;
  if (s.heroProb <= 0) return { html: 'Nothing here needs the hero anymore: the runbook covers it.' };
  return { seen: n > 0 ? 'heroWait' : null,
    html: n ? `<b>${n} item${n > 1 ? 's' : ''}</b> here can't move until the hero walks over. Nobody else knows how to do them.`
      : `About <b>${Math.round(s.heroProb * 100)}%</b> of the work here needs the hero. Right now nothing is waiting for them.` };
}

function hire(G, s) {
  const kind = s.key === 'gate' ? 'officer' : s.key === 'ops' ? 'junior' : 'normal';
  const w = makeWorker(kind, s.workers.length + 1);
  if (s.key === 'ops') s.workers.splice(s.workers.length - 1, 0, w); else s.workers.push(w);
  layoutWorkers(s);
}

const TOOLS = {
  kanban: {
    name: 'Kanban board', kind: 'buy', cost: 3,
    desc: 'Put every piece of work on one shared board. Lifts the fog and reveals hidden work.',
    apply: G => {
      G.owned.kanban = true;
      const wip = computeKpis(G).wip;
      const people = G.st.slice(1).reduce((n, s) => n + s.workers.length, 0);
      mentorSay(G, `${wip} things in progress for ${people} people. All of it started, none of it finished, and nobody could see it. How long do you think each one has to wait?`);
    },
    callout: { kpi: 'wip', title: 'Work in progress (WIP)', text: 'Everything that was started but isn\'t finished yet. Every extra item makes all the others wait longer.' },
    reveal: G => {
      const floor = G.crates.filter(c => c.loc >= 1 && c.loc <= 4), hidden = floor.filter(c => c.shadow).length;
      return ['Fog lifted', `${floor.length} items in progress`, hidden ? `${hidden} of them came in through the hallway, without a ticket` : 'All of it was there the whole time'];
    },
  },
  singleIntake: {
    name: 'Single intake', kind: 'buy', cost: 3,
    desc: 'All requests go through Demand. No more hallway favors straight to engineers.',
    apply: G => { G.owned.singleIntake = true; },
  },
  freeze: {
    name: 'Project freeze', kind: 'toggle',
    desc: 'Stop starting: new work waits at Demand until the floor drops below a fixed cap of work in progress. Only fires still go straight in.',
    get: G => !!G.flags.freeze, set: (G, v) => { G.flags.freeze = v; },
  },
  teamOvertime: {
    name: 'Team overtime', kind: 'buy', cost: 2, trap: true,
    desc: 'Everyone works late for two days. More hours, more output, right?',
    apply: G => { G.teamOT = { until: G.t + 1.5 * G.k, burn: G.t + 5.5 * G.k }; },
    why: 'Overtime gives a short burst, then tired people slow down and make more mistakes. Defects and rework grow. It treats a symptom while the cause (too much WIP) stays.',
    after: 'The team is exhausted now. Notice the slowdown and the defects coming back as rework.',
  },
  markConstraint: {
    name: 'Mark the constraint', kind: 'target', cost: 0, step: 'Identify',
    desc: 'Step 1 · Identify. Click the station that limits the flow of the whole factory.',
    valid: (G, s) => s.i >= 1 && !G.steps.identify,
    apply: (G, s) => {
      if (s.key === G.L.constraint) {
        G.marked = s.i; G.steps.identify = true;
        mentorSay(G, `Yes, ${s.name}. Strictly speaking it's the hero, because only they can do that work. Every hour the hero spends elsewhere is an hour the whole factory loses.`);
      } else {
        mentorSay(G, `${s.name}? Look again. Where does work pile up, and whose ring is always red? Busy isn't the same as constraining.`);
      }
    },
  },
  protectHero: {
    name: 'Protect the hero', kind: 'buy', cost: 2, step: 'Exploit',
    desc: 'Step 2 · Exploit. The hero only leaves Ops when there\'s nothing for them there. Escalations wait.',
    apply: G => { G.flags.protectHero = true; G.steps.exploit = true; },
  },
  rope: {
    name: 'Pace the release', kind: 'buy', cost: 2, step: 'Subordinate',
    desc: 'Step 3 · Subordinate. Release new work only as fast as the constraint can absorb it.',
    apply: G => { G.flags.rope = true; G.steps.subordinate = true; },
  },
  runbook: {
    name: 'Write a runbook', kind: 'target', cost: 2, repeat: true, step: 'Elevate',
    desc: 'Step 4 · Elevate. The hero documents what only they know, so others can do it. Costs the hero about a day.',
    valid: (G, s) => s.i >= 1 && s.heroProb > 0 && !G.hero.doc,
    apply: (G, s) => { G.hero.doc = { i: s.i, timer: .8 }; },
  },
  hire: {
    name: 'Hire a specialist', kind: 'target', cost: 5, repeat: true,
    desc: 'Add a worker to a station of your choice.',
    valid: (G, s) => s.i >= 1 && s.i <= 4 && s.workers.length < 4,
    apply: (G, s) => hire(G, s),
    trap: (G, s) => s.key !== G.L.constraint || s.heroProb > 0,
    why: (G, s) => s.key === 'ops' && s.heroProb > 0
      ? 'The new hire can\'t deploy without the hero\'s knowledge, so they mostly stand around. The constraint was knowledge, not hands. Write runbooks first.'
      : `${s.name} wasn't the constraint. Adding capacity there just builds a bigger pile in front of the real bottleneck, and throughput stays the same.`,
    after: 'New hire on board. Did throughput go up? Check the KPI.',
  },
  heroOvertime: {
    name: 'Hero works overtime', kind: 'buy', cost: 1, trap: true,
    desc: 'Ask your star engineer to push through the weekend.',
    apply: G => { G.hero.otUntil = G.t + 2 * G.k; G.hero.burnUntil = G.t + 5.5 * G.k; },
    why: 'Heroics feel like they help. Then the hero burns out, slows down and makes mistakes, and becomes an even tighter bottleneck. The fix is to need the hero less, not to push them harder.',
    after: 'The hero looks worn out. The constraint just got slower.',
  },
  wipLimits: {
    name: 'WIP limits', kind: 'buy', cost: 0,
    desc: 'Unlock limits per station (click a station or open the board). A station only pulls new work when it has room.',
    apply: G => { G.owned.wipLimits = true; mentorSay(G, 'Limits unlocked. Click a station to set its limit. A good start is about twice the number of workers.'); },
  },
  utilDrive: {
    name: 'Keep everyone 100% busy', kind: 'toggle', trap: true,
    desc: 'Nobody should ever be idle. Push all waiting work onto the floor immediately.',
    get: G => !!G.flags.utilDrive, set: (G, v) => { G.flags.utilDrive = v; },
    why: 'Near 100% utilization, wait time explodes (wait = busy ÷ idle). People multitask and context-switch and finish less. Idle time at non-constraints is healthy slack.',
    after: 'Everyone is busy now. Is anything finishing faster? Look at lead time.',
  },
  debtSlider: {
    name: 'Debt paydown', kind: 'slider', min: 0, max: .4, step: .05,
    desc: 'Share of incoming work reserved for internal improvements that pay down technical debt.',
    get: G => G.debtShare, set: (G, v) => { G.debtShare = v; }, fmt: v => Math.round(v * 100) + '%',
    locked: G => G.locks.debt > G.t,
  },
  monitoring: {
    name: 'Fix the feedback pipe', kind: 'buy', cost: 4,
    desc: 'Monitoring and telemetry: incidents are spotted in minutes instead of when customers call, and tests catch more defects.',
    apply: G => { G.fq = 1; G.owned.monitoring = true; mentorSay(G, 'Feedback flows again. Now you hear about problems before your customers do.'); },
  },
  firefighters: {
    name: 'Hire firefighters', kind: 'buy', cost: 5, trap: true,
    desc: 'A dedicated Ops worker who only fights fires.',
    apply: G => { const ops = G.st[4]; ops.workers.splice(ops.workers.length - 1, 0, makeWorker('fire')); layoutWorkers(ops); },
    why: 'Fires get put out a bit faster, but nothing stops them from starting. Debt keeps growing, and so does the fire rate. Fix the cause: pay down debt and repair feedback.',
    after: 'The firefighter is busy. Are there fewer fires, though?',
  },
  preapprove: {
    name: 'Pre-approve standard changes', kind: 'buy', cost: 2,
    desc: 'Low-risk, repeatable changes skip the gate. The gate can finally review the risky ones properly.',
    apply: G => { G.owned.preapprove = true; },
  },
  shiftLeft: {
    name: 'Build security into Dev', kind: 'buy', cost: 3,
    desc: 'Security checks happen during development. Dev gets a bit slower, audits at the gate become quick.',
    apply: G => { G.owned.shiftLeft = true; },
  },
  cutScope: {
    name: 'Cut compliance scope', kind: 'buy', cost: 3,
    desc: 'Ask the business which systems really matter for compliance. Only those need an audit.',
    apply: G => { G.owned.cutScope = true; mentorSay(G, 'Turns out most of what was being audited never mattered for compliance. Less to protect means less to inspect.'); },
  },
  moreApprovers: {
    name: 'Add more approvers', kind: 'buy', cost: 2, trap: true,
    desc: 'More eyes on every change means fewer failures, right?',
    apply: G => { G.flags.moreApprovers = true; },
    why: 'More approvers slow every change but don\'t understand the risk any better, so failure rates don\'t drop. Approval by people far from the work is mostly theatre. Focus the review on risk instead.',
    after: 'Approvals take longer now. Did the change fail rate move?',
  },
  deployAuto: {
    name: 'Automate deployment', kind: 'buy', cost: 5,
    desc: 'A deploy pipeline does what only the hero could: setup drops from a day to minutes, and anyone can deploy.',
    apply: G => {
      G.owned.deployAuto = true;
      const ops = G.st[4]; ops.heroProb = 0;
      for (const c of ops.q) c.needsHero = false;
    },
  },
  batchSlider: {
    name: 'Batch size', kind: 'slider', min: 1, max: 12, step: 1,
    desc: 'How many items go out together in one deployment.',
    get: G => G.batch, set: (G, v) => { G.batch = v; }, fmt: v => v + (v === 1 ? ' item' : ' items'),
    locked: G => G.locks.batch > G.t,
  },
  autoTests: {
    name: 'Automated tests & telemetry', kind: 'buy', cost: 4,
    desc: 'Every change is tested automatically, and production is monitored. Most defects are caught early, and incidents are spotted within minutes.',
    apply: G => { G.owned.autoTests = true; G.fq = 1; },
  },
  chaosDrill: {
    name: 'Run a chaos drill', kind: 'buy', cost: 2, repeat: true,
    desc: 'Inject a controlled failure and practice fixing it. Each drill makes real incidents faster to fix.',
    apply: G => { spawnFire(G, 4, { inc: newIncident(G, G.t, true), drill: true }); },
  },
  skipTests: {
    name: 'Skip testing', kind: 'toggle', trap: true,
    desc: 'Testing slows us down. Just ship it.',
    get: G => !!G.flags.skipTests, set: (G, v) => { G.flags.skipTests = v; },
    why: 'Skipping tests pushes defects downstream to where they cost most: production, in front of customers. Speed comes from quality, not at its expense.',
    after: 'Tests skipped. Watch the incident count over the next days.',
  },
};

// Decision feedback: which KPIs should move (+1 up, -1 down), when to check,
// where to look on the floor, and why it works.
const FEEDBACK = {
  kanban: { fixed: 'helped', focus: 'test', watch: 'The fog lifts. WIP and lead time become visible.',
    works: 'You can only manage what you can see. The board revealed the hidden work, so you could decide what to finish first.' },
  singleIntake: { expect: { wip: -1 }, delay: 2.5, focus: 'demand', watch: 'Hallway requests stop. WIP should stop creeping up.',
    works: 'One intake means every request is visible and prioritized. Nothing bypasses the queue anymore.' },
  freeze: { expect: { wip: -1 }, delay: 2.5, lag: 'WIP drains only as fast as the constraint finishes work.', focus: 'demand', watch: 'New projects wait. WIP and lead time should drop.',
    works: 'Stopping new starts let the floor finish what it had begun. Less WIP means each item waits less (Little\'s Law).' },
  teamOvertime: { expect: { thr: 1 }, delay: 4, watch: 'More hours for two days. Watch throughput, and what comes after.' },
  markConstraint: { focus: null, watch: 'Step 1: name the constraint before you change anything.',
    works: 'Identifying the constraint first tells you where improvement actually counts.' },
  protectHero: { expect: { thr: 1 }, delay: 2.5, lag: 'Throughput is measured over 3 days, so gains take a while to show.', focus: 'ops', watch: 'The hero stays at Ops. Throughput should rise.',
    works: 'Every hour the hero stays at the constraint is an hour of output for the whole factory.' },
  rope: { expect: { wip: -1 }, delay: 2.5, lag: 'Lead time lags: items already on the floor still have to drain first.', focus: 'demand', watch: 'Work is released at the constraint\'s pace. WIP should fall.',
    works: 'Releasing only what the constraint can absorb stops piles from forming and keeps lead time short.' },
  runbook: { expect: { thr: 1 }, delay: 3.5, lag: 'Writing costs the hero about a day, so throughput dips before it rises. It\'s an investment.', watch: 'The hero writes for about a day, then that station needs them less.',
    works: 'Shared knowledge removes the hero as a dependency. That elevates the constraint without hiring anyone.' },
  hire: { expect: { thr: 1 }, delay: 2, watch: 'More hands at that station. Does factory throughput follow?',
    works: 'Adding capacity at the real constraint raises throughput, but it is the most expensive step. Exploit and subordinate first.' },
  heroOvertime: { expect: { thr: 1 }, delay: 4, focus: 'ops', watch: 'The hero pushes harder. Watch throughput over the next days.' },
  wipLimits: { fixed: 'info', watch: 'Click a station or open the board to set limits.',
    works: 'Unlocking limits is only the first step. The limits you set are what matter.' },
  utilDrive: { expect: { thr: 1 }, delay: 2.5, focus: 'demand', watch: 'Everything is pushed onto the floor. Is anything finishing faster?' },
  monitoring: { expect: { mttr: -1 }, delay: 3, lag: 'Time to restore only changes once new incidents happen and get fixed.', focus: 'ops', watch: 'Incidents are detected in minutes. Time to restore should drop.',
    works: 'Fast feedback finds problems while they are small. Incidents get fixed before customers pile up complaints.' },
  firefighters: { expect: { mttr: -1, unp: -1 }, delay: 3, focus: 'ops', watch: 'A dedicated firefighter. Do fires become rarer?' },
  preapprove: { expect: { lead: -1, cfr: -1 }, delay: 2.5, focus: 'gate', watch: 'Routine changes skip the gate. Lead time and failures should drop.',
    works: 'Routine changes rarely fail. Skipping them lets the gate spend real attention on risky ones, so you get both speed and safety.' },
  shiftLeft: { expect: { lead: -1, thr: 1 }, delay: 2.5, focus: 'dev', watch: 'Security moves into Dev. The gate queue should shrink.',
    works: 'Checks built into daily work are cheaper and faster than inspection at the end.' },
  cutScope: { expect: { lead: -1, thr: 1 }, delay: 2.5, focus: 'gate', watch: 'Fewer items need an audit. The gate queue should shrink.',
    works: 'Protecting what really matters, and only that, removed most of the audit load without adding risk.' },
  moreApprovers: { expect: { cfr: -1 }, delay: 3, focus: 'gate', watch: 'More sign-offs per change. Does the change fail rate drop?' },
  deployAuto: { expect: { deploys: 1 }, delay: 2.5, lag: 'With big batches, automation alone changes little. Shrink the batch size too.', focus: 'ops', watch: 'Deploys take minutes and need no hero. Deploy frequency should rise.',
    works: 'Automation turns the hero\'s knowledge into a repeatable pipeline. Deploying becomes cheap, so you can do it often.' },
  autoTests: { expect: { mttr: -1, cfr: -1 }, delay: 2.5, focus: 'test', watch: 'Defects are caught early, incidents spotted fast.',
    works: 'Fast, automatic feedback catches defects before customers do, and shows incidents within minutes.' },
  chaosDrill: { expect: { mttr: -1 }, delay: 2.5, lag: 'Resilience shows only once a real incident happens.', focus: 'ops', watch: 'A controlled fire. Practice makes real incidents faster to fix.',
    works: 'Rehearsing failure builds the muscle to recover quickly. Each drill shortened your time to restore.' },
  skipTests: { expect: { lead: -1 }, delay: 3, focus: 'test', watch: 'Tests skipped. Faster, maybe. Watch incidents and failures.' },
  limits: { expect: { wip: -1 }, delay: 2.5, lag: 'A limit stops new work entering; the existing pile still has to drain.',
    works: 'With limits, stations pull work only when they have room: less multitasking, shorter queues, shorter lead time.' },
  debtUp: { expect: { debt: -1 }, delay: 3, lag: 'Debt only shrinks when internal work is delivered, which takes a few days.', focus: 'dev',
    works: 'A steady reserve for internal work pays down debt, and every point of debt paid removes future fires.' },
  debtDown: { expect: { thr: 1 }, delay: 3, focus: 'dev',
    works: 'Lowering the reserve buys a few features now and pays for them later with fires.' },
  batchDown: { expect: { deploys: 1, lead: -1 }, delay: 2, focus: 'ops',
    works: 'Smaller batches mean more frequent, lower-risk deploys and faster feedback.' },
  batchUp: { expect: { cfr: -1 }, delay: 2.5, focus: 'ops',
    works: 'Bigger batches mean rarer, riskier deploys. When one fails, it is harder to tell which change caused it.' },
};

function releaseBurst(G, n, type) {
  n *= G.v;
  for (let k = 0; k < n; k++) G.schedule.push({ at: G.t + k * .06 / G.v, fn: g => release(g, newCrate(g, type)) });
}

const LEVELS = [
  // ---------------------------------------------------------------- 0
  {
    id: 0, title: 'The Floor', concept: 'How work flows',
    hook: 'Before your first shift, take a walk across the factory floor with your mentor. Every station, every crate and every number on screen tells you something about how work flows from an idea to a happy customer.',
    learn: ['What each workstation does', 'How a piece of work travels through the pipeline', 'How to read the screen: rings, piles, KPIs, patience'],
    days: 40, vScale: 2, sla: 6, rate: 1.3, mix: { biz: .45, int: .2, chg: .35 }, preload: { dev: 2, test: 3, ops: 1 },
    debt: 0, fq: .6, patience: 80, tour: true,
    kpis: ['lead', 'thr', 'wip', 'unp'],
    tools: [],
    goals: [{ label: 'Walk the floor with the mentor', test: G => !!G.tourDone, show: G => G.tourDone ? 'done' : `${(G.tourStep || 0) + 1}/${TOUR.length}` }],
    stars: () => 3,
    mentor: [],
    hints: ['Use Next and Back in the tour card, or the arrow keys.'],
    reflection: {
      q: 'In which direction does feedback have to flow?',
      options: ['Left to right, together with the work', 'Right to left, from customers and operations back to development', 'Only from managers to the teams'],
      correct: 1,
      explain: 'Work flows left to right, from demand to customers. Feedback must flow right to left, quickly, so problems are found and fixed where they are created.',
    },
    insight: {
      title: 'The Value Stream',
      body: 'Every piece of work travels the same path: demand, development, test, change approval, deployment, customer. Work only creates value when it reaches the customer, and every queue along the way is waiting time.',
      formula: 'Idea → Dev → Test → Gate → Ops → Customer (and feedback back ←)',
    },
  },
  // ---------------------------------------------------------------- 0
  {
    id: 1, title: 'First Day', concept: 'The four types of work',
    hook: 'Welcome to your first day running IT operations. Before you can fix anything, you need to know what kind of work you are dealing with. Requests are arriving at the Demand desk.',
    learn: ['The four types of work', 'Why unplanned work is different from everything else'],
    days: 8.5, tutorial: true, sla: 4, fq: .4, debt: 0, patience: 60,
    items: [
      { from: 'sales', text: 'Launch the new customer loyalty app before the holiday season.', type: 'biz', why: 'New capability the business asked for: a business project.' },
      { from: 'ops', text: 'Migrate the email servers to new hardware.', type: 'int', why: 'IT improving its own infrastructure: an internal IT project.' },
      { from: 'security', text: 'Apply the security patch to the payment database tonight.', type: 'chg', why: 'A modification to a running system: a change.' },
      { from: 'ops', text: 'The web shop is down! Customers can\'t place orders.', type: 'unp', why: 'Nobody planned this, and it interrupts everything else: unplanned work.' },
      { from: 'boss', text: 'Add PayPal as a payment option for the spring campaign.', type: 'biz', why: 'Requested by the business to win customers: a business project.' },
      { from: 'mentor', text: 'Automate the creation of test environments.', type: 'int', why: 'Improves how IT works: an internal project, and the kind that pays down debt.' },
      { from: 'security', text: 'Update the firewall rule for the new logistics partner.', type: 'chg', why: 'A small change to production configuration.' },
      { from: 'ops', text: 'Last night\'s backup failed. Order data is at risk.', type: 'unp', why: 'A fire that must be handled now: unplanned work.' },
    ],
    kpis: ['lead', 'thr', 'wip', 'unp'],
    tools: [],
    goals: [{ label: 'Classify at least 6 of 8 requests correctly', test: G => G.tut.correct >= 6, show: G => `${G.tut.correct}/8` }],
    stars: G => G.tut.correct === 8 ? 3 : G.tut.correct >= 6 ? 2 : 1,
    mentor: [
      { id: 'a', when: G => G.t > 0, text: 'Welcome! I\'ll ask more questions than I answer. First question: what kind of work is coming in?' },
      { id: 'b', when: G => G.tut.idx >= 4, text: 'See how the red one dropped straight into Ops and jumped the line? Unplanned work doesn\'t wait its turn. It pushes everything else back.' },
      { id: 'c', when: G => G.tut.idx >= 8, text: 'All classified. Watch the work flow to the customers. The numbers at the bottom are your KPIs. Hover the ⓘ to learn what each one means.' },
    ],
    hints: ['Ask yourself: who asked for it, and was it planned?'],
    reflection: {
      q: 'Why is unplanned work so dangerous?',
      options: ['It is usually bigger than projects', 'It silently displaces planned work and eats capacity nobody budgeted', 'It cannot be prioritized'],
      correct: 1,
      explain: 'Unplanned work jumps the queue. Every hour spent firefighting is an hour taken from projects and changes, and nobody planned for it.',
    },
    insight: {
      title: 'The Four Types of Work',
      body: 'Business projects, internal IT projects, changes and unplanned work. The first three are planned. Unplanned work is "anti-work": it steals capacity from all the others. Step one is knowing which kind you are doing.',
      formula: 'Planned capacity − unplanned work = what actually gets done',
    },
  },
  // ---------------------------------------------------------------- 1
  {
    id: 2, title: 'Fog of War', concept: 'Make work visible',
    hook: 'Everyone is busy, nothing ships, and nobody can say what\'s in progress. Requests reach engineers through hallways, chats and favors. The floor is in fog.',
    learn: ['You can\'t manage work you can\'t see', 'Hidden WIP is the silent killer', 'Freezing new work lets the pile drain'],
    days: 12, vScale: 2, sla: 3.5, rate: 2, mix: { biz: .45, int: .2, chg: .35 }, workers: { dev: 3, test: 2 },
    fog: true, shadowRate: 2, preload: { dev: 7, test: 7, gate: 1, ops: 2 }, preloadAge: [2, 4], backlogTol: 25, freezeWip: 8,
    debt: 10, fires: true, fireBase: .1, fireDebt: .015, pDef: .05, incDrain: 3, fq: .4, cs: .08, budget: 8,
    patience: 55, wipDrain: { over: 9, rate: .5 }, latePenalty: .5, onTimeBonus: 2.5,
    kpis: ['lead', 'thr', 'wip', 'unp'],
    tools: ['kanban', 'singleIntake', 'freeze', 'teamOvertime'],
    missed: [
      { done: G => (G.toolUses.kanban || 0) > 0, text: 'Kanban board: without it, the hidden WIP stayed invisible and unmanageable.' },
      { done: G => (G.toolUses.singleIntake || 0) > 0, text: 'Single intake: hallway requests kept sneaking unplanned WIP onto the floor.' },
      { done: G => (G.toolUses.freeze || 0) > 0, text: 'Project freeze: stopping new starts lets the floor finish what it began.' },
    ],
    // Tools in `discover` stay hidden until the player has seen the problem they solve.
    discover: {
      kanban: { when: G => G.peeked.size >= 2, late: 4,
        say: 'You walked over and asked. It works, until you look away. Want to do that all day? What if every piece of work sat on one board that everyone can see?' },
      singleIntake: { after: 'kanban', when: G => G.seen.shadow, late: 3,
        say: 'There it is: work that never went through Demand. Somebody asked an engineer directly. As long as there are side doors, no board stays true. How do you close them?' },
      freeze: { after: 'kanban', when: G => G.seen.board && computeKpis(G).wip > 14 * G.v, late: 4,
        say: 'Count the board: that much in progress for a handful of people. Everything waits on everything. What if you stopped starting new projects until the floor has finished some?' },
    },
    goals: [
      { label: 'Find out what\'s going on', tip: 'Click stations in the fog to ask around', test: G => !!G.disc.kanban, show: G => G.disc.kanban ? 'yes' : `${G.peeked.size} / 2 asked` },
      { label: 'Make all work visible', reveal: G => !!G.disc.kanban, test: G => !!G.owned.kanban, show: G => G.owned.kanban ? 'yes' : 'no' },
      { label: 'Work in progress ≤ 28', reveal: G => !!G.owned.kanban, kpi: 'wip', op: '<=', val: 28 },
      { label: 'Lead time ≤ 4.5 days', reveal: G => !!G.owned.kanban, kpi: 'lead', op: '<=', val: 4.5 },
    ],
    events: [{
      day: 4, title: 'A new initiative',
      body: 'A VP drops by: "The board loves this new initiative. Can your team start all six work packages right away, alongside everything else?"',
      options: [
        { label: 'Start all six now', desc: 'Show commitment.', trap: 'Starting more work doesn\'t finish anything sooner. Six more items in progress just make everything else wait longer.', apply: G => { releaseBurst(G, 6, 'biz'); patienceHit(G, 4, 'your decision'); }, expect: { thr: 1 } },
        { label: 'Add them to the backlog', expect: { wip: -1 }, why: 'Keeping new work in the backlog protected the floor from more WIP. Starting later often means finishing sooner.', desc: 'We start them when we have capacity.', apply: G => { for (let k = 0; k < 6 * G.v; k++) addToBacklog(G, newCrate(G, 'biz')); patienceHit(G, -4, 'your decision'); } },
      ],
    }],
    mentor: [
      { id: 'boss', who: 'boss', when: G => G.t > .35, text: 'Why is nothing shipping?! Everyone looks busy. If they have to work late, then they work late. Put the team on overtime!' },
      { id: 'a', when: G => G.t > 1 && !G.disc.kanban, pulse: [1, 2, 3, 4], text: 'Before you spend anything: what is the team working on right now? Neither of us can tell. Click a station in the fog and ask around.' },
      { id: 'a2', when: G => G.peeked.size === 1 && !G.disc.kanban, text: 'Interesting. Now ask at another station. And keep an eye on the first one: how long does what you learned stay true?' },
      { id: 'c', when: G => G.owned.kanban && !G.disc.singleIntake && G.crates.some(c => c.shadow && c.state === 'fall' && c.loc && stationFog(G, c.loc) < .5), text: 'Did you see that? Work just dropped onto the floor without going through Demand. Click that station and find out where it came from.' },
      { id: 'b', when: G => G.owned.kanban && G.t > G.kanbanT + 1.5 && computeKpis(G).wip > 16 * G.v && !G.disc.freeze, text: 'Open the board (B). How much is in progress, compared to how many people work here?' },
      { id: 'd', when: G => G.flags.freeze && G.backlog.length > 12, text: 'The backlog at Demand is growing. That\'s fine: waiting there is cheap. Waiting half-done on the floor is what\'s expensive.' },
    ],
    generic: ['firstRework'],
    hints: ['Click a station in the fog to ask what\'s going on there. Try two different ones.', 'You can\'t fix what you can\'t see. Is there a tool that shows all work at once?', 'Hallway requests keep sneaking in. Click a station right after work drops in from above.', 'Open the board (B). Too much in progress? Stop starting so the floor can finish.'],
    reflection: {
      q: 'Freezing new projects reduced lead time because…',
      options: ['People worked faster', 'Less work in progress means each item waits less', 'The business stopped caring about projects'],
      correct: 1,
      explain: 'Little\'s Law: lead time ≈ WIP ÷ throughput. Throughput barely changed, but WIP shrank, so lead time dropped.',
    },
    insight: {
      title: 'Make Work Visible',
      body: 'Invisible work can\'t be prioritized, limited or finished. Put all work on one board, take all requests through one intake, and when the floor is drowning, stop starting so you can finish.',
      formula: 'Lead time ≈ WIP ÷ Throughput (Little\'s Law)',
    },
  },
  // ---------------------------------------------------------------- 2
  {
    id: 3, title: 'The Hero', concept: 'Theory of Constraints',
    hook: 'One engineer knows how everything works. Everyone needs them, all the time: Dev, Test, the Change Gate. Deliveries are late, and the hero is exhausted.',
    learn: ['Every system has one constraint that sets its pace', 'The Five Focusing Steps', 'An hour lost at the constraint is an hour lost for everyone'],
    days: 12, vScale: 2, sla: 4, rate: 1.9, mix: { biz: .45, int: .2, chg: .35 },
    heroProb: { dev: .3, test: .3, gate: .25, ops: 1 }, showHero: true, constraint: 'ops', ropeN: 8,
    preload: { ops: 5, dev: 3, test: 2 },
    debt: 15, fires: true, fireBase: .15, fireDebt: .015, fq: .4, cs: .03, budget: 9, patience: 60, latePenalty: .5, onTimeBonus: 5, wipDrain: { over: 11, rate: .55 },
    setup: G => { G.owned.kanban = true; },
    kpis: ['lead', 'thr', 'wip', 'unp'],
    tools: ['markConstraint', 'protectHero', 'rope', 'runbook', 'hire', 'heroOvertime'],
    missed: [
      { done: G => G.steps.identify, text: 'Identify: naming the constraint first tells you where improvement counts.' },
      { done: G => G.steps.exploit, text: 'Protect the hero: every interruption stopped deploys for the whole factory.' },
      { done: G => G.steps.subordinate, text: 'Pace the release: pushing more work than Ops could take only grew the piles.' },
      { done: G => G.st[4].heroProb < 1, text: 'A runbook for Ops itself: lets the junior deploy too, which doubles the constraint\'s capacity.' },
      { done: G => G.st[1].heroProb === 0 || G.st[2].heroProb === 0, text: 'Runbooks for Dev and Test: each one stops a stream of escalations that pull the hero away.' },
    ],
    steps: true,
    discover: {
      protectHero: { when: G => G.steps.identify, late: 4,
        say: 'Right: Ops sets the pace, and really it\'s the hero. Now watch them: every time someone calls, they walk away and deploys stop. What if they simply stayed?' },
      runbook: { when: G => G.seen.heroWait, late: 5,
        say: 'Those crates are waiting for one person, because only the hero knows how. Knowledge locked in one head is a constraint. How could others learn it?' },
      rope: { after: 'protectHero', when: G => G.seen.opsPile, late: 3,
        say: 'The hero stays put now, but the pile in front of Ops keeps growing. Does pushing more work onto the floor than Ops can deploy help anyone?' },
    },
    inspect: {
      dev: G => heroWaitInfo(G, 1), test: G => heroWaitInfo(G, 2), gate: G => heroWaitInfo(G, 3),
      ops: G => {
        const s = G.st[4], away = G.hero.state !== 'home';
        return { seen: s.q.length >= 5 * G.v ? 'opsPile' : null,
          html: `<b>${s.q.length} items</b> wait to be deployed. Only the hero can do most deploys, and right now the hero is <b>${away ? 'away at another station' : 'here'}</b>. Pulled away ${G.stats.interruptions}× so far.` };
      },
    },
    goals: [
      { label: 'Identify the constraint', tip: 'Watch where work piles up, then use "Mark the constraint"', test: G => G.steps.identify, show: G => G.steps.identify ? 'yes' : 'no' },
      { label: 'Throughput ≥ 3.4 / day', reveal: G => G.steps.identify, kpi: 'thr', op: '>=', val: 3.4 },
      { label: 'Lead time ≤ 4 days', reveal: G => G.steps.identify, kpi: 'lead', op: '<=', val: 4 },
    ],
    events: [{
      day: 5, title: 'A quick favor',
      body: 'The CEO messages the hero directly: "Can you set up my new phone and take a quick look at my pet project? Today, please."',
      options: [
        { label: 'Send the hero', desc: 'It\'s the CEO, after all.', trap: 'Every "quick favor" taken from the hero is time stolen from the constraint. An hour lost at the bottleneck is an hour lost for the whole company.', apply: G => { G.hero.errandUntil = G.t + 1.2; patienceHit(G, 3, 'your decision'); }, expect: { thr: 1 } },
        { label: 'Route it through Demand', expect: { thr: 1 }, why: 'Routing the favor through Demand kept the hero on the constraint. Requests compete on priority, not on who asks.', desc: 'It gets prioritized like any other work.', apply: G => { addToBacklog(G, newCrate(G, 'biz')); patienceHit(G, -2, 'your decision'); } },
      ],
    }],
    mentor: [
      { id: 'boss', who: 'boss', when: G => G.t > .9, text: 'We pay that one engineer a fortune and still nothing ships. Just hire more people. Problem solved.' },
      { id: 'a', when: G => G.t > 1.2 && !G.steps.identify, pulse: [4], text: 'Crates with a ★ can only be done by the hero. Before you change anything: where does work pile up, and who is always running around? Click the stations, then mark the constraint.' },
      { id: 'b', when: G => G.st[4].q.length > 10 * G.v && !G.steps.identify, text: 'Ops has a growing pile. Is Ops slow, or is someone missing from Ops?' },
      { id: 'e', when: G => G.steps.subordinate && !G.steps.elevate, text: 'Steps 1–3 done. Now the real fix: how can the factory need the hero less?' },
    ],
    generic: ['heroPulled', 'firstIncident'],
    hints: ['Watch the utilization rings and the piles. Where does work wait longest?', 'Every time the hero leaves Ops, deploys stop. Protect them.', 'Releasing more work than the constraint can handle only grows piles.', 'Need the hero less: write runbooks for the stations that keep calling them, including Ops itself.'],
    reflection: {
      q: 'Hiring more developers would not raise throughput here, because…',
      options: ['The new developers need training first', 'Throughput is set by the constraint, and Dev isn\'t it', 'Developers can\'t deploy'],
      correct: 1,
      explain: 'Any improvement not made at the constraint is an illusion. More Dev capacity just builds a bigger pile in front of Ops.',
    },
    insight: {
      title: 'The Five Focusing Steps',
      body: '1. Identify the constraint. 2. Exploit it (never let it idle or do non-constraint work). 3. Subordinate everything else to its pace. 4. Elevate it (here: share the hero\'s knowledge). 5. Repeat, because the constraint moves.',
      formula: 'An hour lost at the constraint = an hour lost for the whole system',
    },
  },
  // ---------------------------------------------------------------- 3
  {
    id: 4, title: 'Too Much Stuff', concept: 'Limit work in progress',
    hook: 'The hero is protected and the runbooks are written. But the floor is drowning in half-finished work. Everyone is 100% busy, and everything is late.',
    learn: ['WIP limits: stop starting, start finishing', 'Wait time explodes near 100% utilization', 'Multitasking makes everyone slower'],
    days: 12, vScale: 2, sla: 4, rate: 2.0, mix: { biz: .5, int: .2, chg: .3 }, constraint: 'test',
    preload: { dev: 4, test: 8, gate: 1, ops: 1 },
    debt: 10, fires: true, fireBase: .15, fireDebt: .015, fq: .5, cs: .1, budget: 7, patience: 45, latePenalty: .5, onTimeBonus: 4.5, wipDrain: { over: 11, rate: .62 },
    setup: G => { G.owned.kanban = true; G.flags.protectHero = true; },
    kpis: ['lead', 'thr', 'wip', 'unp'],
    tools: ['wipLimits', 'hire', 'utilDrive'],
    missed: [
      { done: G => G.st.some(s => s.limit != null), text: 'WIP limits: the core of this shift. Limits cut multitasking, queues and lead time.' },
    ],
    discover: {
      wipLimits: { when: G => G.seen.waitCurve, late: 4,
        say: 'There it is: the busier a station, the longer everything waits, and near 100% it explodes. Busy is not the same as productive. What if a station could only take new work when it has room?' },
    },
    inspect: {
      dev: G => waitInfo(G, 1), test: G => waitInfo(G, 2), gate: G => waitInfo(G, 3), ops: G => waitInfo(G, 4),
    },
    goals: [
      { label: 'Find out why everything is late', tip: 'Click the busiest station and read its wait-time curve', test: G => !!G.disc.wipLimits, show: G => G.disc.wipLimits ? 'yes' : 'no' },
      { label: 'Work in progress ≤ 24', reveal: G => !!G.disc.wipLimits, kpi: 'wip', op: '<=', val: 24 },
      { label: 'Lead time ≤ 3.5 days', reveal: G => !!G.disc.wipLimits, kpi: 'lead', op: '<=', val: 3.5 },
      { label: 'Throughput ≥ 4 / day', reveal: G => !!G.disc.wipLimits, kpi: 'thr', op: '>=', val: 4 },
    ],
    events: [{
      day: 3, title: 'Show some progress',
      body: 'Sales: "Customers want to see progress. Start all six of their projects now so we can say they\'re in progress."',
      options: [
        { label: 'Start all six now', desc: 'Everything "in progress" looks good on a status report.', trap: '"In progress" isn\'t progress. Starting six more items raised WIP and pushed every delivery further out. Only finished work counts.', apply: G => { releaseBurst(G, 6, 'biz'); patienceHit(G, 4, 'your decision'); }, expect: { thr: 1 } },
        { label: 'Pull them as capacity frees up', expect: { lead: -1 }, why: 'Pulling work only when there is room keeps WIP low and lead times short. Customers see real progress: finished work.', desc: 'They start when there\'s room.', apply: G => { for (let k = 0; k < 6 * G.v; k++) addToBacklog(G, newCrate(G, 'biz')); patienceHit(G, -3, 'your decision'); } },
      ],
    }],
    mentor: [
      { id: 'boss', who: 'boss', when: G => G.t > 1, text: 'I walked the floor: people waiting around, desks idle. I want every engineer at 100% utilization. Push more work in!' },
      { id: 'a', when: G => G.t > 1.4 && !G.disc.wipLimits, pulse: [2], text: 'Everyone is at full speed, yet everything is late. Click the busiest station and look at its wait-time curve. What happens to waiting as a station gets close to 100% busy?' },
      { id: 'b', when: G => G.owned.wipLimits && G.st.some(s => s.limit != null), text: 'A limit is set. Now the station pulls work only when it has room. Watch lead time over the next couple of days.' },
      { id: 'c', when: G => G.t > 5 && !G.owned.wipLimits, text: 'Everyone is busy, yet lead time keeps growing. Why isn\'t busy the same as productive?' },
    ],
    generic: ['firstRework'],
    hints: ['Click Test: at 95% utilization, waits are 19× the work time.', 'Unlock WIP limits. Start with about 2× the number of workers per station.', 'Stop starting, start finishing.'],
    reflection: {
      q: 'A station running at 95% utilization has wait times of about…',
      options: ['1× the work time', '2× the work time', '19× the work time'],
      correct: 2,
      explain: 'Wait = busy ÷ idle = 95 ÷ 5 = 19. At 50% it\'s 1×, at 90% it\'s 9×. That\'s why "keep everyone 100% busy" destroys lead time.',
    },
    insight: {
      title: 'Limit Work in Progress',
      body: 'Every item in progress competes for attention. Limiting WIP forces finishing before starting, cuts multitasking and makes lead times short and predictable. Some slack at non-constraints isn\'t waste: it absorbs variation.',
      formula: 'Wait time ∝ %busy ÷ %idle',
    },
  },
  // ---------------------------------------------------------------- 4
  {
    id: 5, title: 'Fires', concept: 'Unplanned work & technical debt',
    hook: 'Years of shortcuts are coming due. Systems break daily, customers notice before you do, and the team spends half its time firefighting.',
    learn: ['Technical debt turns into unplanned work', 'Reserve ~20% capacity for internal improvements', 'Fast feedback shrinks every problem'],
    days: 12, vScale: 2, sla: 4, rate: 1.9, mix: { biz: .55, int: .1, chg: .35 },
    debtSlider: true, debtShare: .05, debt: 55, debtDyn: { up: 2.5, down: 11 },
    fires: true, fireBase: .05, fireDebt: .015, fq: 0, cs: .04, budget: 8, patience: 40, latePenalty: .5, onTimeBonus: 2.5, incDrain: 16, debtDrain: { over: 58, rate: .35 },
    setup: G => { G.owned.kanban = true; G.flags.protectHero = true; },
    kpis: ['unp', 'debt', 'mttr', 'thr'],
    tools: ['debtSlider', 'monitoring', 'firefighters'],
    missed: [
      { done: G => G.debtShare >= .2, text: 'A ~20% debt reserve: less than that, and debt keeps feeding the fires.' },
      { done: G => (G.toolUses.monitoring || 0) > 0, text: 'Fix the feedback pipe: without monitoring, you learn about incidents from angry customers.' },
    ],
    discover: {
      monitoring: { when: G => G.seen.lateDetect, late: 3.5,
        say: 'The customers told you about that outage before your own systems did. You\'re flying blind. How would you find out in minutes instead of days?' },
      debtSlider: { when: G => G.seen.fireCause, late: 4.5,
        say: 'That fire wasn\'t bad luck. It\'s interest on old shortcuts, and every rushed feature adds more. What if part of all work went into paying the debt back?' },
    },
    inspect: {
      dev: G => fireInfo(G, 1), test: G => fireInfo(G, 2), gate: G => fireInfo(G, 3),
      ops: G => fireInfo(G, 4) || detectInfo(G),
    },
    goals: [
      { label: 'Find where the fires come from', tip: 'Click a station while it is burning', test: G => !!G.disc.debtSlider, show: G => G.disc.debtSlider ? 'yes' : 'no' },
      { label: 'Tech debt ≤ 45', reveal: G => !!G.disc.debtSlider, kpi: 'debt', op: '<=', val: 45 },
      { label: 'Unplanned work ≤ 35%', reveal: G => !!G.disc.debtSlider, kpi: 'unp', op: '<=', val: 35 },
      { label: 'Time to restore ≤ 0.8 days', reveal: G => !!G.disc.monitoring, kpi: 'mttr', op: '<=', val: .8 },
    ],
    events: [{
      day: 4, title: 'Feature blitz',
      body: 'Marketing: "Big campaign this month. We need 100% of IT on features. Internal stuff can wait."',
      options: [
        { label: 'All hands on features', desc: 'Debt paydown goes to 0% for four days.', trap: 'Skipping debt paydown buys a few features now and pays for them with fires later. Unplanned work grows until it eats far more than the 20% you "saved".', apply: G => { G.locks.debt = G.t + 4; patienceHit(G, 6, 'your decision'); }, expect: { thr: 1 } },
        { label: 'Keep the reserve', expect: { debt: -1 }, why: 'Holding the reserve kept debt shrinking. Fewer fires means more capacity for those very features.', desc: 'Explain why the 20% protects their campaign.', apply: G => { patienceHit(G, -4, 'your decision'); } },
      ],
    }],
    mentor: [
      { id: 'boss', who: 'boss', when: G => G.t > 1, text: 'Another outage?! Get a dedicated firefighting crew in here. Nobody touches the old systems, we have features to ship.' },
      { id: 'a', when: G => G.t > 1.2 && !G.disc.debtSlider, text: 'Fire after fire. Putting them out isn\'t enough. Click a station while it\'s burning: where do these fires come from?' },
      { id: 'b', when: G => G.t > 3 && G.debtShare < .15, text: 'Debt keeps rising and so do the fires. What share of your work goes into paying it down?' },
      { id: 'c', when: G => G.debtShare >= .2 && G.t > 1, text: 'About 20% for internal work. It feels slow at first. Watch the debt KPI over the next days.' },
    ],
    generic: ['firstIncident', 'firstRework'],
    hints: ['Reserve around 20% of incoming work for internal improvements.', 'You only learn about incidents when customers call. Fix the feedback pipe.'],
    reflection: {
      q: 'Why reserve ~20% of capacity for internal work?',
      options: ['To keep engineers happy', 'Otherwise debt becomes unplanned work that eats far more than 20%', 'Because auditors require it'],
      correct: 1,
      explain: 'Debt you never pay back comes back as fires. A steady reserve keeps unplanned work from taking over the whole capacity.',
    },
    insight: {
      title: 'Pay Down Technical Debt',
      body: 'Every shortcut is a loan. Left unpaid, the interest arrives as outages and firefighting. Reserve about 20% of capacity for internal improvements, and build fast feedback so problems are found while they\'re small and cheap.',
      formula: 'Unpaid debt → unplanned work → less capacity → more shortcuts',
    },
  },
  // ---------------------------------------------------------------- 5
  {
    id: 6, title: 'The Gatekeeper', concept: 'Change & security',
    hook: 'After an audit scare, the security officer insists on reviewing everything at the Change Gate. Every item now waits in line for a stamp, and changes still fail.',
    learn: ['Risk-based change management', 'Build security into daily work', 'Protect what actually matters'],
    days: 12, vScale: 2, sla: 4, rate: 2.2, mix: { biz: .35, int: .15, chg: .5 }, constraint: 'gate',
    risky: .45, riskyFail: .35, stdFail: .05, flags: { auditAll: true }, auditTime: .45,
    preload: { gate: 10, dev: 3, test: 2 },
    debt: 15, fires: true, fireBase: .1, fireDebt: .015, fq: .5, cs: .03, budget: 8, patience: 60, latePenalty: .5, onTimeBonus: 2.5, incDrain: 3.5, wipDrain: { over: 12, rate: .75 },
    setup: G => { G.owned.kanban = true; G.flags.protectHero = true; },
    kpis: ['cfr', 'lead', 'thr', 'wip'],
    tools: ['preapprove', 'shiftLeft', 'cutScope', 'moreApprovers'],
    missed: [
      { done: G => (G.toolUses.preapprove || 0) > 0, text: 'Pre-approve standard changes: the gate wasted its attention on routine work.' },
      { done: G => (G.toolUses.shiftLeft || 0) > 0, text: 'Build security into Dev: inspection at the end stayed slow and expensive.' },
      { done: G => (G.toolUses.cutScope || 0) > 0, text: 'Cut compliance scope: most audited items never mattered for compliance.' },
    ],
    discover: {
      preapprove: { when: G => G.seen.gateMix, late: 3.5,
        say: 'Most of what waits at the gate is routine: the same safe changes, reviewed like brain surgery. Meanwhile the risky ones get the same quick stamp. What if routine changes didn\'t need a review at all?' },
      shiftLeft: { after: 'preapprove', when: G => G.seen.gateAudit, late: 3,
        say: 'Even without the routine changes, every item still sits through a full security audit at the very end. What if security was part of building it, not an inspection afterwards?' },
      cutScope: { after: 'preapprove', when: G => G.seen.gateAudit && G.discT.shiftLeft != null && G.t > G.discT.shiftLeft + .6, late: 4,
        say: 'And who decided that all of this needs an audit? Ask the business which systems really matter for compliance.' },
    },
    inspect: {
      gate: G => {
        const q = G.st[3].q, rout = q.filter(c => c.type === 'chg' && c.risk === 'std').length;
        const risky = q.filter(c => c.risk === 'risky').length, other = q.filter(c => c.type !== 'chg').length;
        if (!G.owned.preapprove) return { seen: q.length ? 'gateMix' : null,
          html: `Waiting for a stamp: <b>${q.length}</b>. Routine standard changes: <b>${rout}</b>. Not even changes: <b>${other}</b>. Actually risky: <b>${risky}</b>. Every one gets the same review.` };
        return { seen: 'gateAudit', html: `Routine changes skip the gate now. Each remaining item still gets a full <b>security audit</b> here at the end, about ${G.owned.shiftLeft ? 'a few hours' : 'half a day'} each.` };
      },
    },
    goals: [
      { label: 'Find out what the gate spends its time on', tip: 'Click the Change Gate', test: G => !!G.disc.preapprove, show: G => G.disc.preapprove ? 'yes' : 'no' },
      { label: 'Change fail rate ≤ 10%', reveal: G => !!G.disc.preapprove, kpi: 'cfr', op: '<=', val: 10 },
      { label: 'Lead time ≤ 4 days', reveal: G => !!G.disc.preapprove, kpi: 'lead', op: '<=', val: 4 },
      { label: 'Throughput ≥ 3.8 / day', reveal: G => !!G.disc.preapprove, kpi: 'thr', op: '>=', val: 3.8 },
    ],
    events: [{
      day: 5, title: 'After the outage',
      body: 'A change caused an outage last night. Leadership: "Freeze ALL changes for three days until we understand what happened."',
      options: [
        { label: 'Freeze all changes', desc: 'Nothing changes, nothing breaks.', trap: 'A freeze doesn\'t remove risk, it piles it up. Changes queue up and later ship together in a riskier burst, while the business waits.', apply: G => { G.locks.chgFreeze = G.t + 3; patienceHit(G, 3, 'your decision'); }, expect: { cfr: -1 } },
        { label: 'Blameless review, keep flowing', expect: { lead: -1 }, why: 'A blameless review finds the real cause without stopping the flow. Risk is handled, not postponed.', desc: 'Find the cause, fix the process.', apply: G => { patienceHit(G, -3, 'your decision'); mentorSay(G, 'Blameless review done: the failed change was a risky one that got the same superficial stamp as everything else.'); } },
      ],
    }],
    mentor: [
      { id: 'sec', who: 'security', when: G => G.t > .7, text: 'Every change gets the full review. No exceptions. If production breaks, it will not be because we skipped a signature.' },
      { id: 'sec2', who: 'security', when: G => G.t > 4 && G.st[3].q.length > 8 * G.v, text: 'The approval queue is long because we are thorough. If you want it faster, give me more approvers.' },
      { id: 'a', when: G => G.t > 1.4 && !G.disc.preapprove, pulse: [3], text: 'The pile at the Change Gate keeps growing, and changes still fail. Click the gate: what is all that reviewing actually spent on?' },
      { id: 'b', when: G => G.stats.deploys.some(d => d.failed) && !G.owned.preapprove, text: 'A change failed even though it was approved. Did the approval actually look at the risk?' },
      { id: 'c', when: G => G.owned.preapprove && G.owned.shiftLeft && G.owned.cutScope, text: 'Security is now part of the flow instead of a wall at the end. That\'s how it should feel.' },
    ],
    generic: ['firstFail'],
    hints: ['Most changes are routine. Do they need a review at all?', 'What if security checks happened while the work is built?', 'Ask the business what really matters for compliance.'],
    reflection: {
      q: 'What reduces change failures most effectively?',
      options: ['More approvers on every change', 'Focus review on risky changes and build quality and security into the work', 'Freeze changes after every incident'],
      correct: 1,
      explain: 'Pre-approve the routine, review the risky properly, and move checks into daily work. Approvals far from the work add delay, not safety.',
    },
    insight: {
      title: 'Change Without Fear',
      body: 'Not all changes are equal: pre-approve standard changes and spend review effort on the risky ones. Build security into development instead of inspecting at the end, and reduce scope to what the business really needs protected.',
      formula: 'Safety comes from risk focus + built-in quality, not from more gates',
    },
  },
  // ---------------------------------------------------------------- 6
  {
    id: 7, title: 'Flow', concept: 'The Three Ways',
    hook: 'Deploys go out in big, scary releases that cost the hero a whole day and often break things. The business wants to ship every day.',
    learn: ['First Way: flow, with small batches', 'Second Way: fast feedback', 'Third Way: learn through practice'],
    days: 12, vScale: 2, sla: 3.5, rate: 2.5, mix: { biz: .45, int: .2, chg: .35 },
    risky: .25, riskyFail: .15, batch: 8, opsSetup: 2, heroProb: { ops: 1 },
    debt: 25, fires: true, fireBase: .1, fireDebt: .015, fq: .5, cs: .03, budget: 12, patience: 26, latePenalty: .5, wipDrain: { over: 7, rate: .9 },
    setup: G => { G.owned.kanban = true; G.flags.protectHero = true; },
    kpis: ['deploys', 'mttr', 'cfr', 'lead'],
    tools: ['deployAuto', 'batchSlider', 'autoTests', 'chaosDrill', 'skipTests'],
    missed: [
      { done: G => (G.toolUses.deployAuto || 0) > 0, text: 'Automate deployment: each manual deploy cost the hero a whole day.' },
      { done: G => G.batch <= 2, text: 'Small batches: big releases are rare, risky and hard to debug.' },
      { done: G => (G.toolUses.autoTests || 0) > 0, text: 'Automated tests & telemetry: fast feedback cuts both failures and time to restore.' },
      { done: G => (G.toolUses.chaosDrill || 0) > 0, text: 'Chaos drills: practicing failure makes real incidents faster to fix.' },
    ],
    discover: {
      deployAuto: { when: G => G.seen.opsDeploy, late: 3,
        say: 'A whole day of the hero, for every deploy. No wonder everyone waits for a big batch. What if a deploy took minutes and anyone could press the button?' },
      autoTests: { when: G => G.seen.failCause, late: 5,
        say: 'A deploy failed and nobody can say which change broke it, or when we\'ll even notice next time. How would you find defects before production, and spot incidents in minutes?' },
      chaosDrill: { after: 'autoTests', when: G => G.stats.mttr.length > 0 && G.seen.st_ops, late: 3,
        say: 'You fix incidents, but every one is a surprise. Firefighters practice. What if your team practiced failure on purpose?' },
    },
    inspect: {
      ops: G => {
        const last = G.stats.deploys[G.stats.deploys.length - 1];
        if (last && last.failed && !G.owned.autoTests) return { seen: 'failCause',
          html: `The last deploy shipped <b>${last.n} changes at once</b> and broke. Which one did it? Nobody knows. Tests caught only a fraction of the defects.` };
        if (G.owned.deployAuto) return { html: `Deploys are automated: minutes instead of a day. Batch size: <b>${G.batch}</b>.` };
        return { seen: 'opsDeploy', html: `Each deploy costs the hero <b>hours of manual setup</b>, plus a bit per item. So work waits until a batch of <b>${G.batch}</b> is together.` };
      },
    },
    goals: [
      { label: 'Find out why deploys are so rare', tip: 'Click Ops / Deploy', test: G => !!G.disc.deployAuto, show: G => G.disc.deployAuto ? 'yes' : 'no' },
      { label: 'Deploy frequency ≥ 4 / day', reveal: G => !!G.disc.deployAuto, kpi: 'deploys', op: '>=', val: 4 },
      { label: 'Lead time ≤ 3.5 days', reveal: G => !!G.disc.deployAuto, kpi: 'lead', op: '<=', val: 3.5 },
      { label: 'Change fail rate ≤ 10%', reveal: G => !!G.disc.autoTests, kpi: 'cfr', op: '<=', val: 10 },
      { label: 'Time to restore ≤ 0.6 days', reveal: G => !!G.disc.autoTests, kpi: 'mttr', op: '<=', val: .6 },
    ],
    events: [{
      day: 4, title: 'Big-bang release',
      body: 'Leadership: "Let\'s bundle everything into one big quarterly release. Fewer deployments, fewer chances to break things."',
      options: [
        { label: 'One big release', desc: 'Batch size goes to 12 for four days.', trap: 'Big batches feel safer but are riskier: more changes per deploy, higher odds that one breaks, and much harder to find which one did.', apply: G => { G.batch = 12; G.locks.batch = G.t + 4; patienceHit(G, 3, 'your decision'); }, expect: { cfr: -1 } },
        { label: 'Keep shipping small', expect: { deploys: 1 }, why: 'Small batches keep each deploy low-risk and feedback fast.', desc: 'Show them the change fail rate.', apply: G => { patienceHit(G, -3, 'your decision'); } },
      ],
    }],
    mentor: [
      { id: 'boss', who: 'boss', when: G => G.t > 1, text: 'The competition ships daily. Testing is slowing us down. Can we just skip it for this release?' },
      { id: 'a', when: G => G.t > 1.2 && !G.disc.deployAuto, pulse: [4], text: 'The business wants to ship every day, and we ship about once a week. Click Ops / Deploy: what does a single deploy cost?' },
      { id: 'b', when: G => G.stats.deploys.length === 1, text: 'One deploy, many items, one long day. If it breaks, which item caused it?' },
      { id: 'c', when: G => computeKpis(G).deploys >= 2 * G.v, text: 'Ship small, ship often. Each deploy is boring now, and that\'s the goal.' },
    ],
    generic: ['firstFail', 'firstIncident'],
    hints: ['Automate deploys first, otherwise every deploy costs a day of the hero.', 'Smaller batches: less risk per deploy and faster feedback.', 'Chaos drills make the team faster at real incidents.'],
    reflection: {
      q: 'Small batches help because…',
      options: ['Each deploy is lower risk, feedback is faster, and failures are easy to trace', 'They need fewer approvals', 'They keep more people busy'],
      correct: 0,
      explain: 'Small batches flow faster, fail smaller and give feedback sooner. With automation, deploying becomes a non-event.',
    },
    insight: {
      title: 'The Three Ways',
      body: 'First Way: optimize the flow from idea to customer, with small batches and never passing defects downstream. Second Way: amplify feedback from right to left. Third Way: build a culture of experimentation and practice, where failure is rehearsed, not feared.',
      formula: 'Flow → Feedback → Continual learning',
    },
  },
];

// Guided tour for shift 0. `rect` is a world-space floor area to highlight, `at` anchors the card.
const chip = t => typeIcon(t, 'tchip');
const TOUR = [
  { title: 'Your value stream', rect: [.5, 4.1, 21.3, 4.9], at: [11, 4.5, 0],
    text: 'This conveyor belt is your pipeline. Every crate is one piece of work. It travels from left to right: from a request at <b>Demand</b> to a happy <b>Customer</b>. Work only creates value once it arrives on the right.' },
  { title: 'Demand', station: 0, at: [1.6, 1, 1], task: { text: 'Click the Demand desk to inspect it.', done: () => UI.selected === 0 },
    text: 'Requests from the business arrive here and wait in a pile until they are <b>released</b> onto the floor. Waiting here is cheap. Waiting half-done on the floor is expensive, as you\'ll learn.' },
  { title: 'Four kinds of work', rect: [.5, 4.1, 21.3, 4.9], at: [7, 4.5, 0],
    text: `The colour tells you the type of work:<br>${chip('biz')} Business project &nbsp; ${chip('int')} Internal IT project<br>${chip('chg')} Change &nbsp; ${chip('unp')} Unplanned work (burning crates that drop from the sky and jump the queue)` },
  { title: 'Dev', station: 1, at: [5.5, 1, 1.4],
    text: 'Developers build the work: features, improvements, changes. Crates queue up on the belt in front of the station and get picked up one by one. Shortcuts taken here come back later as <b>defects</b>.' },
  { title: 'Test', station: 2, at: [9.5, 1, 1.4],
    text: 'Testers check the work. A caught defect flies <b>back to Dev</b> (rework). That is cheap. A defect that slips through becomes an incident in front of customers. That is expensive.' },
  { title: 'Change Gate', station: 3, at: [13.5, 3, 1.6],
    text: 'Changes to production need approval here (the CAB). Items that need no approval hop over the gate. A gate that reviews everything the same way can easily become the bottleneck without making anything safer.' },
  { title: 'Ops / Deploy', station: 4, at: [17.5, 1, 1.4],
    text: 'Operations deploys the work to production and fights the fires. The orange worker with the ★ is the <b>hero</b>: the one person who knows how everything works. Keep an eye on them.' },
  { title: 'Customers', rect: [21.2, .7, 23, 6.7], at: [22, 2, 1],
    text: 'Delivered work reaches your customers. Each on-time delivery raises <b>business patience</b>. When an incident hits, the houses flash red and patience drains until it is fixed.' },
  { title: 'Reading a station', station: 2, at: [9.5, 1, 1.4], task: { text: 'Click the Test station and look at its wait-time curve.', done: () => UI.selected === 2 },
    text: 'The <b>ring</b> above each station shows how busy it is: green is relaxed, red is overloaded. A <b>pile of crates</b> in front of a station is a queue: work that is waiting. Click a station to inspect it: the panel shows its queue and the wait-time curve.' },
  { title: 'Work in progress', rect: [2.2, 4.1, 18.6, 4.9], at: [10, 4.5, 0], wipPills: true,
    text: 'Every crate between Dev and Ops is <b>work in progress (WIP)</b>: started, but not finished yet. The labels above each station count it. More WIP doesn\'t mean more output, it means every item waits longer: <b>lead time ≈ WIP ÷ throughput</b>.' },
  { title: 'The feedback pipe', rect: [1, .1, 21.5, .5], at: [11, .3, 2.6],
    text: 'Above the floor, signals flow back from <b>right to left</b>: monitoring, alerts, customer reports. Fast, bright pulses mean you hear about problems quickly. A broken pipe means you learn about them from angry customers.' },
  { title: 'Your cockpit', hud: true,
    text: 'Bottom: the <b>KPIs</b> (hover the ⓘ for the formula behind each one). Top: your <b>targets</b> and <b>business patience</b>, your session limit, since the shift fails at 0. Left: <b>goals</b> and the <b>toolbox</b>. Right: the <b>floor chatter</b> (mentor, board, security) and your <b>decision log</b>.' },
  { title: 'Ready for your first day', at: null,
    text: 'That\'s the whole floor. In every shift you\'ll face a new problem, use tools from the toolbox, and see whether your decisions really helped. Some tools are traps. Let\'s go!' },
];

// Ambient factory for the title screen.
const DEMO_LEVEL = {
  id: -1, days: 1e9, vScale: 2, rate: 2.0, mix: { biz: .45, int: .2, chg: .35 }, preload: { dev: 3, test: 5, ops: 3 },
  heroProb: { dev: .15, test: .15, ops: .6 }, debt: 30, fires: true, fireBase: .15, fireDebt: .01, fq: .5, cs: .03,
  backlogTol: 1e9,
};
