'use strict';

const $ = (id) => document.getElementById(id);
const EQ_NAMES = ['Balanced', 'Rock', 'Electronic', 'Pop', 'Enhance Vocals', 'Classical', 'Custom'];

let curEq = 0;
let curBassOn = false;
let curLowLat = false;
let curConnected = false;
let curNcOpen = false;

function send(action) {
  if (window.cmf && window.cmf.popoverAction) window.cmf.popoverAction(action);
}

function updateScale() {
  const w = window.innerWidth || 256;
  const h = window.innerHeight || 188;
  const baseH = curConnected ? (curNcOpen ? 214 : 188) : 124;
  const sx = Math.max(0.50, Math.min(1.50, w / 256));
  const sy = Math.max(0.46, Math.min(1.50, h / baseH));
  const s = Math.min(sx, sy);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--sx', sx.toFixed(3));
  rootStyle.setProperty('--sy', sy.toFixed(3));
  rootStyle.setProperty('--s', s.toFixed(3));
  const root = $('mini-root');
  if (root) {
    root.dataset.narrow = w < 205 ? '1' : '0';
    root.dataset.micro = w < 176 ? '1' : '0';
  }
}

function fitHeight() {
  updateScale();
  if (!window.cmf || !window.cmf.popoverResize) return;
  const targetH = curConnected ? (curNcOpen ? 214 : 188) : 124;
  window.cmf.popoverResize(targetH);
}

function renderBatt(key, val, chg, eta) {
  const cell = $('mb-' + key);
  const vEl = $('mv-' + key);
  const cEl = $('mc-' + key);
  const eEl = $('meta-' + key);
  const bEl = $('mbar-' + key);
  const off = val === null || val === undefined || isNaN(val);
  cell.classList.toggle('disc', off);
  if (off) {
    cell.classList.remove('low', 'charging');
    vEl.textContent = '—';
    cEl.style.display = 'none';
    if (eEl) eEl.textContent = '—';
    bEl.style.width = '0%';
    return;
  }
  cell.classList.toggle('low', val <= 20);
  cell.classList.toggle('charging', !!chg);
  vEl.textContent = val + '%';
  cEl.style.display = chg ? 'inline' : 'none';
  if (eEl) eEl.textContent = eta || (chg ? 'Charging' : '—');
  bEl.style.width = val + '%';
}

function render(s) {
  if (!s) return;

  if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
  if (s.accentDim) document.documentElement.style.setProperty('--accent-dim', s.accentDim);

  const codename = s.codename || 'espeon';
  const color = s.color || 'orange';
  const sprite = `assets/buds/${codename}_${color}_right.webp`;
  $('m-bud').src = sprite;
  $('m-disc-img').src = sprite;
  $('m-bud').title = s.connected ? (s.modelName || 'Connected') : 'Disconnected';

  curConnected = !!s.connected;
  $('m-dot').classList.toggle('on', curConnected);
  $('m-disc').style.display = curConnected ? 'none' : '';
  $('m-conn').style.display = curConnected ? '' : 'none';

  if (!curConnected) {
    curNcOpen = false;
    $('m-connect').disabled = !!s.connecting;
    $('m-connect').textContent = s.connecting ? 'Connecting…' : 'Connect';
    fitHeight();
    return;
  }

  // Battery
  const b = s.battery || {};
  const chg = b.chg || {};
  const eta = b.eta || {};
  renderBatt('l', b.l, chg.l, eta.l);
  renderBatt('c', b.c, chg.c, eta.c);
  renderBatt('r', b.r, chg.r, eta.r);

  // ANC
  const anc = Number(s.anc) || 1;
  const mode = anc === 1 ? 'off' : (anc === 2 ? 'trans' : 'nc');
  $('m-anc').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === mode);
  });
  const str = $('m-str');
  curNcOpen = mode === 'nc';
  str.style.display = curNcOpen ? '' : 'none';
  if (str.parentElement) str.parentElement.classList.toggle('nc-open', curNcOpen);
  str.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.lvl) === anc);
  });

  // Bass & Low Latency
  const caps = s.caps || { bass: true, presets: true };
  $('m-bass-wrap').style.display = caps.bass ? '' : 'none';
  curBassOn = !!(s.bass && s.bass.enabled);
  const bassLvl = (s.bass && s.bass.level) || 1;
  $('m-bass-btn').classList.toggle('on', curBassOn);
  const lvls = $('m-blvls');
  lvls.style.display = curBassOn ? '' : 'none';
  lvls.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.lvl) === bassLvl);
  });

  curLowLat = !!s.lowLat;
  $('m-ll-btn').classList.toggle('on', curLowLat);

  // Cyclic EQ
  $('m-eq-row').style.display = caps.presets ? '' : 'none';
  curEq = Math.max(0, Math.min(EQ_NAMES.length - 1, Number(s.eq) || 0));
  $('m-eq-name').textContent = EQ_NAMES[curEq];
  $('m-eq-idx').textContent = `${curEq + 1}/${EQ_NAMES.length}`;

  fitHeight();
}

function stepEq(delta) {
  const next = (curEq + delta + EQ_NAMES.length) % EQ_NAMES.length;
  curEq = next;
  send({ type: 'eq', level: next });
}

$('m-switch').addEventListener('click', () => send({ type: 'switch-mode', mode: 'quick' }));
$('m-open').addEventListener('click', () => send({ type: 'open-main' }));
$('m-disc-open').addEventListener('click', () => send({ type: 'open-main' }));
$('m-close').addEventListener('click', () => send({ type: 'close' }));
$('m-connect').addEventListener('click', () => send({ type: 'connect' }));

$('m-anc').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const m = b.dataset.mode;
  if (m === 'off') send({ type: 'anc', level: 1 });
  else if (m === 'trans') send({ type: 'anc', level: 2 });
  else if (m === 'nc') send({ type: 'anc', level: 'nc' });
});

$('m-str').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  send({ type: 'anc', level: Number(b.dataset.lvl) });
});

$('m-bass-btn').addEventListener('click', () => send({ type: 'bass-toggle', on: !curBassOn }));
$('m-blvls').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  send({ type: 'bass-level', level: Number(b.dataset.lvl) });
});

$('m-ll-btn').addEventListener('click', () => send({ type: 'low-lat', on: !curLowLat }));

$('m-eq-prev').addEventListener('click', () => stepEq(-1));
$('m-eq-next').addEventListener('click', () => stepEq(1));
$('m-eq-cur').addEventListener('click', () => stepEq(1));

window.addEventListener('resize', updateScale);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') send({ type: 'close' });
});

updateScale();

if (window.cmf) {
  window.cmf.onPopoverState(render);
  window.cmf.popoverGetState().then(render).catch(() => {});
}
