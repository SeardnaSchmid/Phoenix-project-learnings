'use strict';
// Main loop, input and screen wiring.

function viewRect() {
  if (UI.screen === 'title') return { x: 540, y: 40, w: Math.max(300, innerWidth - 580), h: Math.max(200, innerHeight - 80) };
  return { x: 324, y: 76, w: Math.max(300, innerWidth - 324 - 314), h: Math.max(200, innerHeight - 76 - 132) };
}

function step(G, dtReal) {
  let d = dtReal / daySec(G);
  while (d > 0) { const s = Math.min(d, .01); update(G, s); d -= s; }
}

// The untouched twin advances in lockstep and mirrors the player's event choices.
function stepGhost(dtReal) {
  const H = UI.ghost;
  if (!H || H.ended || !resolveGhostEvent(H)) return;
  step(H, dtReal);
  resolveGhostEvent(H);
}
function resolveGhostEvent(H) {
  const m = H.pendingModal;
  if (!m) return true;
  if (m.type !== 'event') { H.pendingModal = null; return true; }
  const choice = UI.G.choices[m.ev.idx];
  if (choice == null) return false;
  m.ev.options[choice].apply(H);
  H.pendingModal = null;
  return true;
}

function stationAt(mx, my) {
  const G = UI.G;
  if (!G) return null;
  const p = toWorld(mx, my);
  for (const s of G.st) {
    const [x0, y0, x1, y1] = platformRect(s);
    const inPlat = p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    const inQueue = s.i > 0 && p.y >= 4.1 && p.y <= 5 && p.x >= s.x - 2.6 && p.x <= s.x + .3;
    if (inPlat || inQueue) return s.i;
  }
  return null;
}

let last = performance.now(), hudT = 0;
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000);
  last = now;
  fitView(viewRect());
  if (UI.screen === 'title') {
    step(UI.demo, dt);
    drawScene(UI.demo, { hover: null, selected: null, targeting: null, validTarget: () => false });
    copySharp();
  } else if (UI.G) {
    const G = UI.G;
    if (!UI.modal && G.speed > 0 && !G.ended) { step(G, dt * G.speed); stepGhost(dt * G.speed); }
    if (!UI.modal && G.pendingModal) {
      const m = G.pendingModal;
      G.pendingModal = null;
      if (m.type === 'event') showEvent(m.ev);
      else if (m.type === 'classify') showClassify(m.item, m.idx);
    }
    if (!UI.modal && G.ended && !G.debriefed) { G.debriefed = true; showDebrief(); }
    drawScene(G, UI);
    hudT -= dt;
    if (hudT <= 0) { hudT = .15; updateHud(); }
  }
  requestAnimationFrame(frame);
}

function setSpeed(v) {
  const G = UI.G;
  if (!G) return;
  if (v > 0) UI.lastSpeed = v;
  G.speed = v;
  updateHud();
}

// Title screen: copy the blurred factory into an unblurred canvas that is masked around the cursor.
const sharp = document.getElementById('sceneSharp'), sharpCtx = sharp.getContext('2d');
function copySharp() {
  if (sharp.width !== cv.width || sharp.height !== cv.height) {
    sharp.width = cv.width; sharp.height = cv.height;
    sharp.style.width = cv.style.width; sharp.style.height = cv.style.height;
  }
  sharpCtx.clearRect(0, 0, sharp.width, sharp.height);
  sharpCtx.drawImage(cv, 0, 0);
}
addEventListener('mousemove', e => {
  if (UI.screen !== 'title') return;
  sharp.style.setProperty('--mx', e.clientX + 'px');
  sharp.style.setProperty('--my', e.clientY + 'px');
});
document.addEventListener('mouseleave', () => {
  sharp.style.setProperty('--mx', '-999px');
  sharp.style.setProperty('--my', '-999px');
});

// ---------- input ----------
cv.addEventListener('mousemove', e => {
  if (UI.screen !== 'game') return;
  UI.hover = stationAt(e.clientX, e.clientY);
  cv.style.cursor = UI.hover != null ? 'pointer' : 'default';
});
cv.addEventListener('click', e => {
  if (UI.screen !== 'game' || UI.modal) return;
  const i = stationAt(e.clientX, e.clientY);
  if (UI.targeting) {
    if (i != null && UI.validTarget(UI.G.st[i])) useTool(UI.targeting, UI.G.st[i]);
    return;
  }
  if (i == null) closeStation();
  else if (UI.selected === i) closeStation();
  else openStation(i);
});
addEventListener('keydown', e => {
  if (UI.screen !== 'game' || UI.modal) return;
  if (e.target.tagName === 'INPUT') return;
  if (tourActive() && (e.key === 'ArrowRight' || e.key === 'Enter')) { tourGo(1); return; }
  if (tourActive() && e.key === 'ArrowLeft') { tourGo(-1); return; }
  if (e.code === 'Space') { e.preventDefault(); setSpeed(UI.G.speed > 0 ? 0 : UI.lastSpeed); }
  else if (e.key === '1') setSpeed(1);
  else if (e.key === '2') setSpeed(2);
  else if (e.key === '3') setSpeed(4);
  else if (e.key === 'b' || e.key === 'B') toggleBoard();
  else if (e.key === 'Escape') { UI.targeting = null; showTargetHint(); closeStation(); updateTools(); }
});

document.querySelectorAll('#speedBtns button').forEach(b => b.onclick = () => setSpeed(Number(b.dataset.sp)));
$('#btnBoard').onclick = toggleBoard;
$('#btnTheme').onclick = toggleTheme;
$('#btnThemeTitle').onclick = toggleTheme;
$('#btnExit').onclick = confirmExit;
$('#btnHint').onclick = nextHint;
$('#btnDeck').onclick = showDeck;
$('#btnUnlock').onclick = () => { UI.save.unlockAll = true; persist(); renderTitle(); };
$('#btnReset').onclick = () => {
  if (!confirm('Reset all progress? Stars and discovered tools will be lost.')) return;
  UI.save = { theme: UI.save.theme }; persist(); renderTitle();
};
$('#btnBrief').onclick = showBrief;
$('#btnEnd').onclick = confirmEnd;

// ---------- boot ----------
applyTheme(UI.save.theme || 'dark');
UI.demo = newGame(DEMO_LEVEL, { demo: true });
showTitle();
requestAnimationFrame(frame);
