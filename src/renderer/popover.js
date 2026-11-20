'use strict';

const $ = (id) => document.getElementById(id);

function send(action) {
  if (window.cmf && window.cmf.popoverAction) window.cmf.popoverAction(action);
}

function fitHeight() {
  if (!window.cmf || !window.cmf.popoverResize) return;
  requestAnimationFrame(() => {
    const h = Math.ceil($('pop-root').scrollHeight);
    if (h > 0) window.cmf.popoverResize(h);
  });
}

function renderBatteryCell(key, val, chg, eta) {
  const cell = $('pb-' + key);
  const valEl = $('pv-' + key);
  const chgEl = $('pc-' + key);
  const etaEl = $('peta-' + key);
  const barEl = $('pbar-' + key);
  const off = val === null || val === undefined || isNaN(val);
  cell.classList.toggle('disc', off);
  if (off) {
    cell.classList.remove('low', 'charging');
    valEl.textContent = '—';
    chgEl.style.display = 'none';
    if (etaEl) etaEl.textContent = '—';
    barEl.style.width = '0%';
    return;
  }
  cell.classList.toggle('low', val <= 20);
  cell.classList.toggle('charging', !!chg);
  valEl.textContent = val + '%';
  chgEl.style.display = chg ? 'inline' : 'none';
  if (etaEl) etaEl.textContent = eta || (chg ? 'Charging' : '—');
  barEl.style.width = val + '%';
}

function render(s) {
  if (!s) return;

  if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
  if (s.accentDim) document.documentElement.style.setProperty('--accent-dim', s.accentDim);

  const dot = $('status-dot');
  dot.classList.toggle('on', !!s.connected);
  $('pop-dev').textContent = s.connected
    ? (s.modelName || 'Connected')
    : (s.connecting ? 'Connecting…' : 'Disconnected');

  $('view-disc').style.display = s.connected ? 'none' : '';
  $('view-conn').style.display = s.connected ? '' : 'none';

  if (!s.connected) {
    const codename = s.codename || 'espeon';
    const color = s.color || 'orange';
    $('disc-img').src = `assets/buds/${codename}_${color}_right.webp`;
    $('btn-pop-connect').disabled = !!s.connecting;
    $('btn-pop-connect').textContent = s.connecting ? 'Connecting…' : 'Connect';
    $('disc-title').textContent = s.connecting ? 'Looking for your buds…' : 'Buds not connected';
    fitHeight();
    return;
  }

  // Battery
  const b = s.battery || {};
  const chg = b.chg || {};
  const eta = b.eta || {};
  renderBatteryCell('l', b.l, chg.l, eta.l);
  renderBatteryCell('c', b.c, chg.c, eta.c);
  renderBatteryCell('r', b.r, chg.r, eta.r);

  // ANC
  const anc = Number(s.anc) || 1;
  const mode = anc === 1 ? 'off' : (anc === 2 ? 'trans' : 'nc');
  $('p-anc-seg').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === mode);
  });
  const strWrap = $('p-anc-str');
  strWrap.style.display = mode === 'nc' ? '' : 'none';
  strWrap.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.lvl) === anc);
  });

  // Bass Enhance
  const caps = s.caps || { bass: true, presets: true };
  $('p-sec-bass').style.display = caps.bass ? '' : 'none';
  const bassOn = !!(s.bass && s.bass.enabled);
  const bassLvl = (s.bass && s.bass.level) || 1;
  $('p-bass-on').checked = bassOn;
  const lvlWrap = $('p-bass-lvls');
  lvlWrap.style.display = bassOn ? '' : 'none';
  lvlWrap.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.lvl) === bassLvl);
  });

  // EQ Presets
  $('p-sec-eq').style.display = caps.presets ? '' : 'none';
  $('p-eq-chips').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.eq) === Number(s.eq));
  });

  // Low Latency
  $('p-low-lat').checked = !!s.lowLat;

  fitHeight();
}

// Wire controls
$('btn-switch-mini').addEventListener('click', () => send({ type: 'switch-mode', mode: 'mini' }));
$('btn-open-main').addEventListener('click', () => send({ type: 'open-main' }));
$('btn-pop-open').addEventListener('click', () => send({ type: 'open-main' }));
$('btn-pop-connect').addEventListener('click', () => send({ type: 'connect' }));
$('btn-pop-disc').addEventListener('click', () => send({ type: 'disconnect' }));

$('p-anc-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const m = b.dataset.mode;
  if (m === 'off') send({ type: 'anc', level: 1 });
  else if (m === 'trans') send({ type: 'anc', level: 2 });
  else if (m === 'nc') send({ type: 'anc', level: 'nc' });
});

$('p-anc-str').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  send({ type: 'anc', level: Number(b.dataset.lvl) });
});

$('p-bass-on').addEventListener('change', (e) => {
  send({ type: 'bass-toggle', on: e.target.checked });
});

$('p-bass-lvls').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  send({ type: 'bass-level', level: Number(b.dataset.lvl) });
});

$('p-eq-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  send({ type: 'eq', level: Number(b.dataset.eq) });
});

$('p-low-lat').addEventListener('change', (e) => {
  send({ type: 'low-lat', on: e.target.checked });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') send({ type: 'close' });
});

if (window.cmf) {
  window.cmf.onPopoverState(render);
  window.cmf.popoverGetState().then(render).catch(() => {});
}
