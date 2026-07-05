// H2R-style layout editor. Talks to the backend over WebSocket; the backend pushes
// every edit live into OBS. Box fields are normalized 0..1 over the canvas; the UI
// displays them as pixels using the canvas dimensions.
const $ = (id) => document.getElementById(id);

let ws = null;
let state = {
  canvas: { width: 1920, height: 1080 },
  saved: [],
  layout: null,
  currentProgramScene: null,
};
let selectedSlot = 1;
let clipboard = null;
let lockAspect = false;

// True while dragging/resizing (and briefly after) so the server's box echoes can't
// clobber the in-progress edit (which otherwise "snaps back" to a stale position).
let interacting = false;
let graceTimer = null;

const canvasEl = $('canvas');
const stageEl = document.querySelector('.stage');
const boxEls = {}; // slot -> element

// --- connection -----------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { $('status').textContent = 'connected'; send({ type: 'hello' }); };
  ws.onclose = () => { $('status').textContent = 'disconnected — reconnecting…'; setTimeout(connect, 1500); };
  ws.onerror = () => { $('status').textContent = 'connection error'; };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'state':
      state.canvas = msg.canvas || state.canvas;
      state.saved = msg.saved || state.saved;
      state.currentProgramScene = msg.currentProgramScene || null;
      if (msg.layout) state.layout = msg.layout;
      populateSaved();
      populateSwitch();
      fitCanvas();
      renderAll();
      updateLiveStatus();
      break;
    case 'layout':
      state.layout = msg.layout;
      renderAll();
      break;
    case 'box':
      if (interacting) break; // don't let a stale echo fight the active drag
      if (!state.layout) break;
      {
        const i = state.layout.boxes.findIndex((b) => b.slot === msg.slot);
        if (i >= 0) state.layout.boxes[i] = clampBox(msg.box);
        renderBox(msg.slot);
        if (msg.slot === selectedSlot) syncSidebar();
      }
      break;
    case 'saved':
      state.saved = msg.saved || [];
      populateSaved();
      populateSwitch();
      break;
    case 'switched':
      state.currentProgramScene = msg.scene || null;
      populateSwitch();
      updateLiveStatus();
      break;
    case 'error':
      $('status').textContent = 'error: ' + msg.error;
      break;
    default:
      break;
  }
}

// --- model helpers --------------------------------------------------------

function box(slot) {
  return state.layout ? state.layout.boxes.find((b) => b.slot === slot) : null;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const W = () => state.canvas.width;
const H = () => state.canvas.height;
const fmt = (n, dim) => Math.round(n * dim);

function clampBox(b) {
  b.crop = b.crop || [0, 0, 0, 0];
  b.crop[0] = clamp(b.crop[0], 0, 0.95);
  b.crop[1] = clamp(b.crop[1], 0, 0.95 - b.crop[0]);
  b.crop[2] = clamp(b.crop[2], 0, 0.95);
  b.crop[3] = clamp(b.crop[3], 0, 0.95 - b.crop[2]);
  return b;
}

function updateLiveStatus() {
  const s = state.currentProgramScene;
  $('status').textContent = s ? `program: ${s.replace(/^Super Source • Layout: /, '')}` : 'connected';
}

// --- select population ----------------------------------------------------

function populateSaved() {
  const sel = $('saved');
  const cur = sel.value;
  sel.innerHTML = '';
  if (!state.saved.length) {
    const o = document.createElement('option');
    o.textContent = '(none yet)';
    o.value = '';
    sel.appendChild(o);
    return;
  }
  for (const s of state.saved) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

function populateSwitch() {
  const grid = $('switchGrid');
  grid.innerHTML = '';
  if (!state.saved.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Save layouts to get quick-switch buttons here.';
    grid.appendChild(p);
    return;
  }
  for (const s of state.saved) {
    const b = document.createElement('button');
    b.textContent = s.name;
    b.title = `Take "${s.name}" to Program`;
    if (state.currentProgramScene === `Super Source • Layout: ${s.name}`) b.classList.add('live');
    b.addEventListener('click', () => send({ type: 'switchSaved', id: s.id }));
    grid.appendChild(b);
  }
}

// --- rendering ------------------------------------------------------------

function ensureBoxEls() {
  for (let s = 1; s <= 4; s++) {
    if (!boxEls[s]) {
      const el = document.createElement('div');
      el.className = 'box';
      el.dataset.slot = s;
      el.innerHTML = `<span class="label">Slot ${s}</span>` +
        `<div class="crop"><i class="cl"></i><i class="cr"></i><i class="ct"></i><i class="cb"></i></div>` +
        `<div class="handle"></div>`;
      canvasEl.appendChild(el);
      boxEls[s] = el;
      attachPointer(el, s);
    }
  }
}

function renderAll() {
  ensureBoxEls();
  const sel = $('slot');
  if (!sel.options.length) {
    for (let s = 1; s <= 4; s++) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      sel.appendChild(o);
    }
  }
  if (state.layout) {
    $('name').value = state.layout.name;
    $('bgUrl').value = (state.layout.bg && state.layout.bg.src) || '';
    const fx = state.layout.effects || {};
    $('fxRadius').value = fx.corner_radius || 0;
    $('fxBorder').value = fx.border_width || 0;
    const bc = fx.border_color || 0xFFFFFFFF;
    $('fxBorderColor').value = '#' + [bc & 255, (bc >> 8) & 255, (bc >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('');
    for (const b of state.layout.boxes) renderBox(b.slot);
    selectBox(selectedSlot);
  } else {
    for (let s = 1; s <= 4; s++) boxEls[s].style.display = 'none';
  }
}

function renderBox(slot) {
  const b = box(slot);
  if (!b) return;
  const el = boxEls[slot];
  el.style.display = b.enabled ? 'flex' : 'none';
  el.style.left = (b.pos[0] * 100) + '%';
  el.style.top = (b.pos[1] * 100) + '%';
  el.style.width = (b.size[0] * 100) + '%';
  el.style.height = (b.size[1] * 100) + '%';
  // crop lines inside the box
  const crop = el.querySelector('.crop');
  if (crop) {
    crop.querySelector('.cl').style.left = (b.crop[0] * 100) + '%';
    crop.querySelector('.cr').style.right = (b.crop[1] * 100) + '%';
    crop.querySelector('.ct').style.top = (b.crop[2] * 100) + '%';
    crop.querySelector('.cb').style.bottom = (b.crop[3] * 100) + '%';
  }
}

function selectBox(slot) {
  selectedSlot = slot;
  for (const s of Object.keys(boxEls)) {
    boxEls[s].classList.toggle('selected', Number(s) === slot);
  }
  syncSidebar();
}

// --- canvas sizing --------------------------------------------------------

function fitCanvas() {
  const ratio = state.canvas.width / state.canvas.height;
  const pad = 48;
  let w = stageEl.clientWidth - pad;
  let h = stageEl.clientHeight - pad;
  if (w / h > ratio) w = h * ratio;
  else h = w / ratio;
  canvasEl.style.width = Math.max(120, w) + 'px';
  canvasEl.style.height = Math.max(68, h) + 'px';
}

// --- interaction: drag / resize ------------------------------------------

function normPoint(e) {
  const r = canvasEl.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function attachPointer(el, slot) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('handle')) {
      startResize(e, slot);
    } else {
      selectBox(slot);
      startDrag(e, slot);
    }
  });
}

function beginInteract() {
  interacting = true;
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
}
function endInteract() {
  flushBox();
  graceTimer = setTimeout(() => { interacting = false; graceTimer = null; }, 250);
}

function startDrag(e, slot) {
  e.preventDefault();
  beginInteract();
  const b = box(slot);
  const start = normPoint(e);
  const orig = [...b.pos];
  const lock = { x: {}, y: {} };
  const move = (ev) => {
    const p = normPoint(ev);
    let nx = clamp(orig[0] + (p.x - start.x), -(b.size[0] - 0.05), 0.95);
    let ny = clamp(orig[1] + (p.y - start.y), -(b.size[1] - 0.05), 0.95);
    const { thX, thY } = snapThresholds();
    const snap = snapBox(nx, ny, b.size, thX, thY, lock);
    nx = snap.x;
    ny = snap.y;
    showGuides(snap.guides);
    b.pos = [nx, ny];
    renderBox(slot);
    syncSidebar();
    showMeasures(slot);
    sendBox(slot);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    clearGuides();
    clearMeasures();
    endInteract();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startResize(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  selectBox(slot);
  beginInteract();
  const b = box(slot);
  const start = normPoint(e);
  const orig = [...b.size];
  const lock = { x: {}, y: {} };
  const move = (ev) => {
    const p = normPoint(ev);
    let w = orig[0] + (p.x - start.x);
    let h = orig[1] + (p.y - start.y);
    if (ev.shiftKey || lockAspect) {
      // keep the box's aspect ratio (no squeezed video)
      const ar = orig[0] / orig[1];
      if (w / orig[0] > h / orig[1]) h = w / ar;
      else w = h * ar;
      w = clamp(w, 0.02, 1);
      h = clamp(h, 0.02, 1);
      clearGuides();
    } else {
      w = clamp(w, 0.02, 1);
      h = clamp(h, 0.02, 1);
      const { thX, thY } = snapThresholds();
      const snap = snapSize(w, h, b.pos, thX, thY, lock);
      w = snap.w;
      h = snap.h;
      showGuides(snap.guides);
    }
    b.size = [w, h];
    renderBox(slot);
    syncSidebar();
    showMeasures(slot);
    sendBox(slot);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    clearGuides();
    clearMeasures();
    endInteract();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// --- snapping (hysteresis: catch a guide, hold it, release cleanly) ------

function snapThresholds() {
  const px = Number($('snapPx').value);
  if (!px || px <= 0) return { thX: 0, thY: 0 };
  return { thX: px / state.canvas.width, thY: px / state.canvas.height };
}

const GUIDE_TARGETS = [0, 0.5, 1];

function applySnap(unsnapped, edges, th, lock) {
  if (th <= 0) return { pos: unsnapped, guide: null };
  if (lock.i !== undefined) {
    const e = edges[lock.i];
    if (Math.abs(lock.g - e.val) < th) return { pos: unsnapped + e.corr(lock.g), guide: lock.g };
    lock.i = undefined;
  }
  let best = null;
  for (let i = 0; i < edges.length; i++) {
    for (const g of GUIDE_TARGETS) {
      const d = Math.abs(g - edges[i].val);
      if (d < th && (!best || d < best.d)) best = { i, g, d };
    }
  }
  if (best) {
    lock.i = best.i;
    lock.g = best.g;
    return { pos: unsnapped + edges[best.i].corr(best.g), guide: best.g };
  }
  return { pos: unsnapped, guide: null };
}

function snapBox(x, y, size, thX, thY, lock) {
  const sx = applySnap(x, [
    { val: x, corr: (g) => g - x },
    { val: x + size[0] / 2, corr: (g) => g - (x + size[0] / 2) },
    { val: x + size[0], corr: (g) => g - (x + size[0]) },
  ], thX, lock.x);
  const sy = applySnap(y, [
    { val: y, corr: (g) => g - y },
    { val: y + size[1] / 2, corr: (g) => g - (y + size[1] / 2) },
    { val: y + size[1], corr: (g) => g - (y + size[1]) },
  ], thY, lock.y);
  const guides = [];
  if (sx.guide !== null) guides.push({ orient: 'v', pos: sx.guide });
  if (sy.guide !== null) guides.push({ orient: 'h', pos: sy.guide });
  return { x: sx.pos, y: sy.pos, guides };
}

function snapSize(w, h, pos, thX, thY, lock) {
  const sx = applySnap(w, [
    { val: pos[0] + w, corr: (g) => (g - pos[0]) - w },
    { val: pos[0] + w / 2, corr: (g) => 2 * (g - pos[0]) - w },
  ], thX, lock.x);
  const sy = applySnap(h, [
    { val: pos[1] + h, corr: (g) => (g - pos[1]) - h },
    { val: pos[1] + h / 2, corr: (g) => 2 * (g - pos[1]) - h },
  ], thY, lock.y);
  const guides = [];
  if (sx.guide !== null) guides.push({ orient: 'v', pos: sx.guide });
  if (sy.guide !== null) guides.push({ orient: 'h', pos: sy.guide });
  return { w: sx.pos, h: sy.pos, guides };
}

function showGuides(guides) {
  clearGuides();
  for (const g of guides) {
    const d = document.createElement('div');
    d.className = `guide ${g.orient}`;
    if (g.orient === 'v') d.style.left = g.pos * 100 + '%';
    else d.style.top = g.pos * 100 + '%';
    canvasEl.appendChild(d);
  }
}
function clearGuides() {
  canvasEl.querySelectorAll('.guide').forEach((g) => g.remove());
}

// --- edge-distance readout (px to each canvas edge, like OBS) -------------

function measuresLayer() {
  let layer = canvasEl.querySelector('#measures');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'measures';
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.pointerEvents = 'none';
    canvasEl.appendChild(layer);
  }
  return layer;
}
let measureTimer = null;
function showMeasures(slot) {
  const b = box(slot);
  if (!b) return;
  const layer = measuresLayer();
  layer.innerHTML = '';
  const L = Math.round(b.pos[0] * W());
  const R = Math.round((1 - b.pos[0] - b.size[0]) * W());
  const T = Math.round(b.pos[1] * H());
  const B = Math.round((1 - b.pos[1] - b.size[1]) * H());
  const cx = (b.pos[0] + b.size[0] / 2) * 100;
  const cy = (b.pos[1] + b.size[1] / 2) * 100;
  const lbl = (txt, l, t, tr) => {
    const d = document.createElement('div');
    d.className = 'measure';
    d.textContent = txt;
    d.style.left = l + '%';
    d.style.top = t + '%';
    d.style.transform = tr;
    layer.appendChild(d);
  };
  lbl(`← ${L}px`, b.pos[0] * 100, cy, 'translate(-110%, -50%)');
  lbl(`${R}px →`, (b.pos[0] + b.size[0]) * 100, cy, 'translate(10%, -50%)');
  lbl(`↑ ${T}px`, cx, b.pos[1] * 100, 'translate(-50%, -110%)');
  lbl(`${B}px ↓`, cx, (b.pos[1] + b.size[1]) * 100, 'translate(-50%, 10%)');
  lbl(`${Math.round(b.size[0] * W())} × ${Math.round(b.size[1] * H())}`, cx, cy, 'translate(-50%, -50%)');
  clearTimeout(measureTimer);
  measureTimer = setTimeout(clearMeasures, 1200);
}
function clearMeasures() {
  if (measureTimer) { clearTimeout(measureTimer); measureTimer = null; }
  const layer = canvasEl.querySelector('#measures');
  if (layer) layer.innerHTML = '';
}

// --- sidebar (units: pixels) ----------------------------------------------

function syncSidebar() {
  const b = box(selectedSlot);
  if (!b) return;
  $('slot').value = selectedSlot;
  $('enabled').checked = b.enabled;
  $('posX').value = fmt(b.pos[0], W());
  $('posY').value = fmt(b.pos[1], H());
  $('sizeW').value = fmt(b.size[0], W());
  $('sizeH').value = fmt(b.size[1], H());
  $('cropL').value = fmt(b.crop[0], W());
  $('cropR').value = fmt(b.crop[1], W());
  $('cropT').value = fmt(b.crop[2], H());
  $('cropB').value = fmt(b.crop[3], H());
}

function setField(field, idx, valuePx, dim) {
  const b = box(selectedSlot);
  if (!b) return;
  const arr = b[field].slice();
  arr[idx] = clamp(valuePx / dim, 0, 1);
  if (field === 'size' && lockAspect) {
    const other = idx === 0 ? 1 : 0;
    const ratio = b.size[other] / b.size[idx]; // normalized ratio preserves pixel aspect
    arr[other] = clamp(arr[idx] * ratio, 0.01, 1);
  }
  b[field] = arr;
  clampBox(b);
  renderBox(selectedSlot);
  syncSidebar();
  if (field === 'pos' || field === 'size') showMeasures(selectedSlot);
  sendBox(selectedSlot);
}

// --- throttled push to OBS ------------------------------------------------

let sendTimer = null;
let pending = null;
function sendBox(slot) {
  const b = box(slot);
  if (!b) return;
  pending = { slot, box: { slot, enabled: b.enabled, pos: [...b.pos], size: [...b.size], crop: [...b.crop] } };
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    if (pending) { send({ type: 'setBox', ...pending }); pending = null; }
  }, 60);
}
function flushBox() {
  if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
  if (pending) { send({ type: 'setBox', ...pending }); pending = null; }
}

// --- wire up controls -----------------------------------------------------

$('slot').addEventListener('change', () => selectBox(Number($('slot').value)));
$('enabled').addEventListener('change', () => {
  const b = box(selectedSlot);
  if (!b) return;
  b.enabled = $('enabled').checked;
  renderBox(selectedSlot);
  sendBox(selectedSlot);
});
$('lockAspect').addEventListener('change', () => { lockAspect = $('lockAspect').checked; });

$('posX').addEventListener('input', () => setField('pos', 0, Number($('posX').value), W()));
$('posY').addEventListener('input', () => setField('pos', 1, Number($('posY').value), H()));
$('sizeW').addEventListener('input', () => setField('size', 0, Number($('sizeW').value), W()));
$('sizeH').addEventListener('input', () => setField('size', 1, Number($('sizeH').value), H()));
$('cropL').addEventListener('input', () => setField('crop', 0, Number($('cropL').value), W()));
$('cropR').addEventListener('input', () => setField('crop', 1, Number($('cropR').value), W()));
$('cropT').addEventListener('input', () => setField('crop', 2, Number($('cropT').value), H()));
$('cropB').addEventListener('input', () => setField('crop', 3, Number($('cropB').value), H()));

$('copyBtn').addEventListener('click', () => {
  const b = box(selectedSlot);
  if (b) clipboard = { pos: [...b.pos], size: [...b.size], crop: [...b.crop] };
});
$('pasteBtn').addEventListener('click', () => {
  const b = box(selectedSlot);
  if (b && clipboard) {
    b.pos = [...clipboard.pos];
    b.size = [...clipboard.size];
    b.crop = [...clipboard.crop];
    clampBox(b);
    renderBox(selectedSlot);
    syncSidebar();
    sendBox(selectedSlot);
  }
});

$('newBtn').addEventListener('click', () => send({ type: 'newLayout', name: $('name').value || undefined }));
$('saveBtn').addEventListener('click', () => send({ type: 'save', name: $('name').value || undefined }));
$('openBtn').addEventListener('click', () => {
  const id = $('saved').value;
  if (id) send({ type: 'open', id });
});
$('deleteBtn').addEventListener('click', () => {
  const id = $('saved').value;
  const name = $('saved').selectedOptions[0]?.textContent;
  if (id && confirm(`Delete saved layout "${name}"? (Also removes its OBS scene.)`)) {
    send({ type: 'deleteLayout', id, name });
  }
});
$('takeBtn').addEventListener('click', () => send({ type: 'switch' }));

$('bgUrl').addEventListener('change', () => {
  send({ type: 'setBackground', src: $('bgUrl').value.trim() || null });
});
$('bgFile').addEventListener('change', async () => {
  const f = $('bgFile').files[0];
  if (!f) return;
  const data = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.readAsDataURL(f);
  });
  try {
    const r = await fetch('/api/bg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name, data }),
    });
    const j = await r.json();
    if (j.src) {
      $('bgUrl').value = j.src;
      send({ type: 'setBackground', src: j.src });
    }
  } catch (e) {
    console.warn('background upload failed', e);
  }
});
$('bgClearBtn').addEventListener('click', () => {
  $('bgUrl').value = '';
  $('bgFile').value = '';
  send({ type: 'setBackground', src: null });
});

// Box effects (debounced — avoid flooding OBS on slider drag)
let effectsTimer = null;
function sendEffects(effects) {
  if (effectsTimer) clearTimeout(effectsTimer);
  effectsTimer = setTimeout(() => send({ type: 'setEffects', effects }), 150);
}
$('fxRadius').addEventListener('input', () => sendEffects({ corner_radius: Number($('fxRadius').value) }));
$('fxBorder').addEventListener('input', () => sendEffects({ border_width: Number($('fxBorder').value) }));
$('fxBorderColor').addEventListener('input', () => {
  const h = $('fxBorderColor').value;
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  sendEffects({ border_color: ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0 });
});

// Arrow-key nudge (ignored while typing in inputs).
window.addEventListener('keydown', (e) => {
  if (!state.layout) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return;
  const b = box(selectedSlot);
  if (!b) return;
  const stepX = (e.shiftKey ? 10 : 1) / W();
  const stepY = (e.shiftKey ? 10 : 1) / H();
  let dx = 0, dy = 0;
  if (e.key === 'ArrowLeft') dx = -stepX;
  else if (e.key === 'ArrowRight') dx = stepX;
  else if (e.key === 'ArrowUp') dy = -stepY;
  else if (e.key === 'ArrowDown') dy = stepY;
  else return;
  e.preventDefault();
  beginInteract();
  b.pos = [clamp(b.pos[0] + dx, -(b.size[0] - 0.05), 0.95), clamp(b.pos[1] + dy, -(b.size[1] - 0.05), 0.95)];
  renderBox(selectedSlot);
  syncSidebar();
  showMeasures(selectedSlot);
  sendBox(selectedSlot);
  endInteract();
});

window.addEventListener('resize', fitCanvas);

// --- go -------------------------------------------------------------------

connect();
