// H2R-style layout editor. Talks to the backend over WebSocket; the backend pushes
// every edit live into OBS. Box fields are normalized 0..1 over the canvas; the UI
// displays them as pixels using the canvas dimensions. Per-box style (radius,
// border, shadow, opacity) is rendered here with CSS approximations of the OBS
// alpha shaders, plus an optional live OBS screenshot backdrop for true WYSIWYG.
const $ = (id) => document.getElementById(id);

let ws = null;
let state = {
  canvas: { width: 1920, height: 1080 },
  saved: [],
  layout: null,
  currentProgramScene: null,
  obs: { connected: false, configured: false },
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

// --- token -----------------------------------------------------------------

const urlToken = new URLSearchParams(location.search).get('token');
let token = urlToken || localStorage.getItem('ssb_token') || '';
if (urlToken) {
  localStorage.setItem('ssb_token', urlToken);
  history.replaceState(null, '', location.pathname);
}

function authFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(path, { ...opts, headers });
}

function promptToken(err) {
  $('tokenError').textContent = err || '';
  $('tokenModal').classList.remove('hidden');
  $('tokenInput').focus();
}
$('tokenSave').addEventListener('click', () => {
  token = $('tokenInput').value.trim();
  if (!token) { promptToken('token required'); return; }
  localStorage.setItem('ssb_token', token);
  $('tokenModal').classList.add('hidden');
  $('tokenError').textContent = '';
  connect();
});
$('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('tokenSave').click(); });
$('logoutBtn').addEventListener('click', () => { localStorage.removeItem('ssb_token'); token = ''; promptToken('token forgotten on this device'); });

// --- toasts ----------------------------------------------------------------

function toast(msg, kind = '') {
  const d = document.createElement('div');
  d.className = `toast ${kind}`;
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

// --- connection ------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${proto}://${location.host}${q}`);
  ws.onopen = () => send({ type: 'hello' });
  ws.onclose = (e) => {
    updateObsChip();
    if (e.code === 4001) { promptToken('invalid or missing token'); return; }
    setTimeout(connect, 1500);
  };
  ws.onerror = () => {};
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
      state.slots = msg.slots || state.slots;
      state.currentProgramScene = msg.currentProgramScene || null;
      state.obs = msg.obs || state.obs;
      if (msg.layout) state.layout = msg.layout;
      populateSaved();
      populateSwitch();
      fitCanvas();
      renderAll();
      updateObsChip();
      break;
    case 'layout':
      state.layout = msg.layout;
      markClean();
      renderAll();
      break;
    case 'box':
      if (interacting) break; // don't let a stale echo fight the active drag
      if (!state.layout) break;
      {
        const i = state.layout.boxes.findIndex((b) => b.slot === msg.slot);
        if (i >= 0) state.layout.boxes[i] = msg.box;
        renderBox(msg.slot);
        renderLayers();
        if (msg.slot === selectedSlot) syncSidebar();
      }
      break;
    case 'saved':
      state.saved = msg.saved || [];
      markClean();
      populateSaved();
      populateSwitch();
      break;
    case 'switched':
      state.currentProgramScene = msg.scene || null;
      populateSwitch();
      updateObsChip();
      break;
    case 'obsStatus':
      state.obs = msg;
      updateObsChip();
      break;
    case 'screenshot':
      if (msg.data) {
        $('obsPreview').src = msg.data;
        $('obsPreview').classList.remove('hidden');
      }
      break;
    case 'error':
      if (/unauthorized/i.test(msg.error)) promptToken('invalid or missing token');
      else toast(msg.error, 'error');
      break;
    default:
      break;
  }
}

// --- model helpers ---------------------------------------------------------

function box(slot) {
  return state.layout ? state.layout.boxes.find((b) => b.slot === slot) : null;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const W = () => state.canvas.width;
const H = () => state.canvas.height;
const fmt = (n, dim) => Math.round(n * dim);
const SLOT_COUNT = () => state.slots?.length || 4;
const pxScale = () => canvasEl.clientWidth / W() || 0.1;

function rgba(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${clamp(opacity, 0, 1)})`;
}

function defaultStyle() {
  return {
    radius: 0,
    border: { width: 0, color: '#ffffff', opacity: 1 },
    shadow: { blur: 0, spread: 0, offsetX: 0, offsetY: 0, color: '#000000', opacity: 0 },
    opacity: 1,
  };
}

// --- undo / redo -----------------------------------------------------------

const undoStack = [];
const redoStack = [];
let undoScope = false;

function beginUndo() {
  if (undoScope || !state.layout) return;
  undoStack.push(JSON.stringify(state.layout));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  undoScope = true;
  updateUndoButtons();
}
function endUndo() {
  if (!undoScope) return;
  undoScope = false;
  markDirty();
}
function applySnapshot(json) {
  state.layout = JSON.parse(json);
  renderAll();
  send({ type: 'setLayout', layout: publicCopy() });
  markDirty();
}
function doUndo() {
  if (!undoStack.length || !state.layout) return;
  redoStack.push(JSON.stringify(state.layout));
  applySnapshot(undoStack.pop());
  updateUndoButtons();
}
function doRedo() {
  if (!redoStack.length || !state.layout) return;
  undoStack.push(JSON.stringify(state.layout));
  applySnapshot(redoStack.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}

let dirty = false;
function markDirty() {
  if (dirty) return;
  dirty = true;
  $('chipDirty').classList.remove('hidden');
}
function markClean() {
  dirty = false;
  $('chipDirty').classList.add('hidden');
}

function publicCopy() {
  return JSON.parse(JSON.stringify(state.layout));
}

// --- select population -----------------------------------------------------

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

// --- rendering -------------------------------------------------------------

function ensureBoxEls() {
  for (let s = 1; s <= SLOT_COUNT(); s++) {
    if (!boxEls[s]) {
      const el = document.createElement('div');
      el.className = 'box';
      el.dataset.slot = s;
      el.innerHTML = `<div class="content"></div>` +
        `<span class="label">Slot ${s}</span>` +
        `<div class="crop"><i class="cl"></i><i class="cr"></i><i class="ct"></i><i class="cb"></i></div>` +
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => `<i class="h ${d}" data-dir="${d}"></i>`).join('');
      canvasEl.appendChild(el);
      boxEls[s] = el;
      attachPointer(el, s);
    }
  }
}

function renderAll() {
  ensureBoxEls();
  const sel = $('slot');
  if (sel.options.length !== SLOT_COUNT()) {
    sel.innerHTML = '';
    for (let s = 1; s <= SLOT_COUNT(); s++) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      sel.appendChild(o);
    }
  }
  if (state.layout) {
    $('name').value = state.layout.name;
    $('bgUrl').value = (state.layout.bg && state.layout.bg.src) || '';
    $('bgLayer').style.backgroundImage = state.layout.bg?.src ? `url("${state.layout.bg.src}")` : 'none';
    for (const b of state.layout.boxes) renderBox(b.slot);
    for (let s = 1; s <= SLOT_COUNT(); s++) {
      if (!box(s)) boxEls[s].style.display = 'none';
    }
    renderLayers();
    selectBox(selectedSlot);
  } else {
    for (const s of Object.keys(boxEls)) boxEls[s].style.display = 'none';
    renderLayers();
  }
  updateUndoButtons();
}

// CSS approximation of the OBS alpha-shader look (radius/border/shadow/opacity).
function renderBox(slot) {
  const b = box(slot);
  if (!b) return;
  const el = boxEls[slot];
  const k = pxScale();
  const st = b.style || defaultStyle();
  el.style.display = b.enabled ? 'block' : 'none';
  el.style.left = (b.pos[0] * 100) + '%';
  el.style.top = (b.pos[1] * 100) + '%';
  el.style.width = (b.size[0] * 100) + '%';
  el.style.height = (b.size[1] * 100) + '%';
  el.style.transform = b.rotation ? `rotate(${b.rotation}deg)` : 'none';

  const content = el.querySelector('.content');
  content.style.left = (b.crop[0] * 100) + '%';
  content.style.right = (b.crop[1] * 100) + '%';
  content.style.top = (b.crop[2] * 100) + '%';
  content.style.bottom = (b.crop[3] * 100) + '%';
  content.style.borderRadius = (st.radius * k) + 'px';
  content.style.border = st.border.width > 0
    ? `${st.border.width * k}px solid ${rgba(st.border.color, st.border.opacity)}` : 'none';
  content.style.opacity = st.opacity;
  content.style.boxShadow = st.shadow.opacity > 0
    ? `${st.shadow.offsetX * k}px ${st.shadow.offsetY * k}px ${st.shadow.blur * k}px ${st.shadow.spread * k}px ${rgba(st.shadow.color, st.shadow.opacity)}`
    : 'none';

  // crop lines inside the box (hidden when that side has no crop — at 0 they would
  // just draw a thick yellow frame over the styled border)
  const crop = el.querySelector('.crop');
  if (crop) {
    const show = (sel, v) => {
      crop.querySelector(sel).style.display = v > 0.0005 ? 'block' : 'none';
    };
    crop.querySelector('.cl').style.left = (b.crop[0] * 100) + '%';
    crop.querySelector('.cr').style.right = (b.crop[1] * 100) + '%';
    crop.querySelector('.ct').style.top = (b.crop[2] * 100) + '%';
    crop.querySelector('.cb').style.bottom = (b.crop[3] * 100) + '%';
    show('.cl', b.crop[0]);
    show('.cr', b.crop[1]);
    show('.ct', b.crop[2]);
    show('.cb', b.crop[3]);
  }
}

function renderLayers() {
  const list = $('layerList');
  list.innerHTML = '';
  if (!state.layout) return;
  const order = state.layout.order || state.layout.boxes.map((b) => b.slot);
  for (const slot of [...order].reverse()) { // front of list = top of stack
    const b = box(slot);
    if (!b) continue;
    const row = document.createElement('div');
    row.className = 'layer-row' + (slot === selectedSlot ? ' selected' : '');
    const name = document.createElement('span');
    name.textContent = `Slot ${slot}`;
    if (!b.enabled) name.classList.add('off');
    name.style.flex = '1';
    const eye = document.createElement('button');
    eye.className = 'zbtn eye';
    eye.textContent = b.enabled ? '👁' : '✕';
    eye.title = b.enabled ? 'Disable (hide in OBS)' : 'Enable';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      beginUndo();
      b.enabled = !b.enabled;
      endUndo();
      renderBox(slot);
      renderLayers();
      sendBox(slot);
      if (slot === selectedSlot) syncSidebar();
    });
    const up = document.createElement('button');
    up.className = 'zbtn';
    up.textContent = '▲';
    up.title = 'Bring forward';
    up.addEventListener('click', (e) => { e.stopPropagation(); moveLayer(slot, +1); });
    const down = document.createElement('button');
    down.className = 'zbtn';
    down.textContent = '▼';
    down.title = 'Send backward';
    down.addEventListener('click', (e) => { e.stopPropagation(); moveLayer(slot, -1); });
    row.append(eye, name, up, down);
    row.addEventListener('click', () => selectBox(slot));
    list.appendChild(row);
  }
}

function moveLayer(slot, delta) {
  if (!state.layout) return;
  const order = [...(state.layout.order || state.layout.boxes.map((b) => b.slot))];
  const i = order.indexOf(slot);
  const j = clamp(i + delta, 0, order.length - 1);
  if (i === j) return;
  beginUndo();
  order.splice(i, 1);
  order.splice(j, 0, slot);
  state.layout.order = order;
  endUndo();
  renderLayers();
  send({ type: 'reorder', order });
}

function selectBox(slot) {
  selectedSlot = slot;
  for (const s of Object.keys(boxEls)) {
    boxEls[s].classList.toggle('selected', Number(s) === slot);
  }
  renderLayers();
  syncSidebar();
}

// --- canvas sizing ---------------------------------------------------------

function fitCanvas() {
  const ratio = state.canvas.width / state.canvas.height;
  const pad = 56;
  let w = stageEl.clientWidth - pad;
  let h = stageEl.clientHeight - pad - 40; // room for the stage toolbar
  if (w / h > ratio) w = h * ratio;
  else h = w / ratio;
  canvasEl.style.width = Math.max(120, w) + 'px';
  canvasEl.style.height = Math.max(68, h) + 'px';
  renderAll(); // px-scaled styling depends on the canvas display size
}

// --- interaction: drag / resize / crop -------------------------------------

function normPoint(e) {
  const r = canvasEl.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function attachPointer(el, slot) {
  el.addEventListener('pointerdown', (e) => {
    const dir = e.target.dataset?.dir;
    const cropCls = e.target.classList?.contains('cl') ? 'l'
      : e.target.classList?.contains('cr') ? 'r'
      : e.target.classList?.contains('ct') ? 't'
      : e.target.classList?.contains('cb') ? 'b' : null;
    if (dir) startResize(e, slot, dir);
    else if (cropCls) startCrop(e, slot, cropCls);
    else { selectBox(slot); startDrag(e, slot); }
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
  beginUndo();
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
    const snap = snapBox(nx, ny, b.size, thX, thY, lock, slot);
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
    window.removeEventListener('pointercancel', up);
    clearGuides();
    clearMeasures();
    endInteract();
    endUndo();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// dir: n/ne/e/se/s/sw/w/nw — the opposite edge/corner stays anchored.
function startResize(e, slot, dir) {
  e.preventDefault();
  e.stopPropagation();
  selectBox(slot);
  beginUndo();
  beginInteract();
  const b = box(slot);
  const start = normPoint(e);
  const orig = { x: b.pos[0], y: b.pos[1], w: b.size[0], h: b.size[1] };
  const lock = { x: {}, y: {} };
  const east = dir.includes('e');
  const west = dir.includes('w');
  const south = dir.includes('s');
  const north = dir.includes('n');

  const move = (ev) => {
    const p = normPoint(ev);
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    let x = orig.x, y = orig.y, w = orig.w, h = orig.h;

    if (east) w = orig.w + dx;
    if (west) { w = orig.w - dx; x = orig.x + dx; }
    if (south) h = orig.h + dy;
    if (north) { h = orig.h - dy; y = orig.y + dy; }

    if (ev.shiftKey || lockAspect) {
      const ar = orig.w / orig.h;
      if (east || west) {
        h = w / ar;
        if (north) y = orig.y + (orig.h - h);
        else if (!south) y = orig.y - (h - orig.h) / 2;
      } else {
        w = h * ar;
        if (west) x = orig.x + (orig.w - w);
        else if (!east) x = orig.x - (w - orig.w) / 2;
      }
      w = clamp(w, 0.02, 1);
      h = clamp(h, 0.02, 1);
      clearGuides();
    } else {
      w = clamp(w, 0.02, 1);
      h = clamp(h, 0.02, 1);
      x = clamp(x, -0.95, 0.95);
      y = clamp(y, -0.95, 0.95);
      const { thX, thY } = snapThresholds();
      const snap = snapResize({ x, y, w, h, orig, east, west, south, north }, thX, thY, lock, slot);
      ({ x, y, w, h } = snap);
      showGuides(snap.guides);
    }

    // keep a minimum size, re-anchoring the moved edge
    if (w < 0.02) { w = 0.02; if (west) x = orig.x + orig.w - w; }
    if (h < 0.02) { h = 0.02; if (north) y = orig.y + orig.h - h; }

    b.size = [w, h];
    b.pos = [x, y];
    renderBox(slot);
    syncSidebar();
    showMeasures(slot);
    sendBox(slot);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    clearGuides();
    clearMeasures();
    endInteract();
    endUndo();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// side: l/r/t/b — drags the crop line inside the box.
function startCrop(e, slot, side) {
  e.preventDefault();
  e.stopPropagation();
  selectBox(slot);
  beginUndo();
  beginInteract();
  const b = box(slot);
  const move = (ev) => {
    const p = normPoint(ev);
    let v;
    if (side === 'l') v = (p.x - b.pos[0]) / b.size[0];
    else if (side === 'r') v = (b.pos[0] + b.size[0] - p.x) / b.size[0];
    else if (side === 't') v = (p.y - b.pos[1]) / b.size[1];
    else v = (b.pos[1] + b.size[1] - p.y) / b.size[1];
    v = clamp(v, 0, 0.95);
    const idx = { l: 0, r: 1, t: 2, b: 3 }[side];
    b.crop[idx] = v;
    clampBox(b);
    renderBox(slot);
    syncSidebar();
    sendBox(slot);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    endInteract();
    endUndo();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// --- snapping (hysteresis: catch a guide, hold it, release cleanly) -------

function snapThresholds() {
  const px = Number($('snapPx').value);
  if (!px || px <= 0) return { thX: 0, thY: 0 };
  return { thX: px / state.canvas.width, thY: px / state.canvas.height };
}

// Canvas targets plus every other enabled box's edges and centers.
function snapTargetsX(excludeSlot) {
  const t = [0, 0.5, 1];
  for (const b of state.layout?.boxes || []) {
    if (b.slot === excludeSlot || !b.enabled) continue;
    t.push(b.pos[0], b.pos[0] + b.size[0] / 2, b.pos[0] + b.size[0]);
  }
  return t;
}
function snapTargetsY(excludeSlot) {
  const t = [0, 0.5, 1];
  for (const b of state.layout?.boxes || []) {
    if (b.slot === excludeSlot || !b.enabled) continue;
    t.push(b.pos[1], b.pos[1] + b.size[1] / 2, b.pos[1] + b.size[1]);
  }
  return t;
}

function applySnap(unsnapped, edges, targets, th, lock) {
  if (th <= 0) return { pos: unsnapped, guide: null };
  if (lock.i !== undefined) {
    const e = edges[lock.i];
    if (Math.abs(lock.g - e.val) < th) return { pos: unsnapped + e.corr(lock.g), guide: lock.g };
    lock.i = undefined;
  }
  let best = null;
  for (let i = 0; i < edges.length; i++) {
    for (const g of targets) {
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

function snapBox(x, y, size, thX, thY, lock, excludeSlot) {
  const targetsX = snapTargetsX(excludeSlot);
  const targetsY = snapTargetsY(excludeSlot);
  const sx = applySnap(x, [
    { val: x, corr: (g) => g - x },
    { val: x + size[0] / 2, corr: (g) => g - (x + size[0] / 2) },
    { val: x + size[0], corr: (g) => g - (x + size[0]) },
  ], targetsX, thX, lock.x);
  const sy = applySnap(y, [
    { val: y, corr: (g) => g - y },
    { val: y + size[1] / 2, corr: (g) => g - (y + size[1] / 2) },
    { val: y + size[1], corr: (g) => g - (y + size[1]) },
  ], targetsY, thY, lock.y);
  const guides = [];
  if (sx.guide !== null) guides.push({ orient: 'v', pos: sx.guide });
  if (sy.guide !== null) guides.push({ orient: 'h', pos: sy.guide });
  return { x: sx.pos, y: sy.pos, guides };
}

// Snap the moving edges of a resize to targets.
function snapResize({ x, y, w, h, orig, east, west, south, north }, thX, thY, lock, excludeSlot) {
  const guides = [];
  if (thX > 0 && (east || west)) {
    const targets = snapTargetsX(excludeSlot);
    const r = applySnap(west ? x : x + w, [
      { val: west ? x : x + w, corr: (g) => g - (west ? x : x + w) },
    ], targets, thX, lock.x);
    if (west) { x = r.pos; w = orig.x + orig.w - x; }
    else w = r.pos - x;
    if (r.guide !== null) guides.push({ orient: 'v', pos: r.guide });
  }
  if (thY > 0 && (south || north)) {
    const targets = snapTargetsY(excludeSlot);
    const btm = applySnap(north ? y : y + h, [
      { val: north ? y : y + h, corr: (g) => g - (north ? y : y + h) },
    ], targets, thY, lock.y);
    if (north) { y = btm.pos; h = orig.y + orig.h - y; }
    else h = btm.pos - y;
    if (btm.guide !== null) guides.push({ orient: 'h', pos: btm.guide });
  }
  return { x, y, w, h, guides };
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
  $('rotation').value = b.rotation || 0;
  $('posX').value = fmt(b.pos[0], W());
  $('posY').value = fmt(b.pos[1], H());
  $('sizeW').value = fmt(b.size[0], W());
  $('sizeH').value = fmt(b.size[1], H());
  $('cropL').value = fmt(b.crop[0], W());
  $('cropR').value = fmt(b.crop[1], W());
  $('cropT').value = fmt(b.crop[2], H());
  $('cropB').value = fmt(b.crop[3], H());
  syncStylePanel(b);
}

function syncStylePanel(b) {
  const st = b.style || defaultStyle();
  $('stRadius').value = st.radius;
  $('stRadiusV').textContent = Math.round(st.radius);
  $('stOpacity').value = Math.round(st.opacity * 100);
  $('stOpacityV').textContent = Math.round(st.opacity * 100);
  $('stBorderW').value = st.border.width;
  $('stBorderWV').textContent = Math.round(st.border.width);
  $('stBorderColor').value = st.border.color;
  $('stBorderO').value = Math.round(st.border.opacity * 100);
  $('stShadowO').value = Math.round(st.shadow.opacity * 100);
  $('stShadowOV').textContent = Math.round(st.shadow.opacity * 100);
  $('stShadowBlur').value = st.shadow.blur;
  $('stShadowSpread').value = st.shadow.spread;
  $('stShadowX').value = st.shadow.offsetX;
  $('stShadowY').value = st.shadow.offsetY;
  $('stShadowColor').value = st.shadow.color;
}

function setField(field, idx, valuePx, dim) {
  const b = box(selectedSlot);
  if (!b) return;
  const arr = b[field].slice();
  arr[idx] = clamp(valuePx / dim, -0.95, 1);
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
  pending = {
    slot,
    box: {
      slot, enabled: b.enabled,
      pos: [...b.pos], size: [...b.size], crop: [...b.crop],
      rotation: b.rotation || 0,
      style: JSON.parse(JSON.stringify(b.style || defaultStyle())),
    },
  };
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

function clampBox(b) {
  b.crop = b.crop || [0, 0, 0, 0];
  b.crop[0] = clamp(b.crop[0], 0, 0.95);
  b.crop[1] = clamp(b.crop[1], 0, 0.95 - b.crop[0]);
  b.crop[2] = clamp(b.crop[2], 0, 0.95);
  b.crop[3] = clamp(b.crop[3], 0, 0.95 - b.crop[2]);
  return b;
}

// --- templates --------------------------------------------------------------

const TEMPLATES = {
  grid2x2: () => {
    const g = 0.012;
    const half = (1 - g) / 2;
    return [
      { slot: 1, pos: [0, 0], size: [half, half] },
      { slot: 2, pos: [half + g, 0], size: [half, half] },
      { slot: 3, pos: [0, half + g], size: [half, half] },
      { slot: 4, pos: [half + g, half + g], size: [half, half] },
    ];
  },
  pipRight: () => {
    const g = 0.012;
    const colW = 0.28;
    const bigW = 1 - colW - g;
    const rowH = (1 - 2 * g) / 3;
    return [
      { slot: 1, pos: [0, 0], size: [bigW, 1] },
      { slot: 2, pos: [bigW + g, 0], size: [colW, rowH] },
      { slot: 3, pos: [bigW + g, rowH + g], size: [colW, rowH] },
      { slot: 4, pos: [bigW + g, 2 * (rowH + g)], size: [colW, rowH] },
    ];
  },
  thirds: () => {
    const g = 0.012;
    const colW = (1 - 2 * g) / 3;
    return [
      { slot: 1, pos: [0, 0], size: [colW, 1] },
      { slot: 2, pos: [colW + g, 0], size: [colW, 1] },
      { slot: 3, pos: [2 * (colW + g), 0], size: [colW, 1] },
      { slot: 4, pos: [0, 0], size: [colW, 0.25], enabled: false },
    ];
  },
  focusStrip: () => {
    const g = 0.012;
    const topH = 0.7;
    const stripH = 1 - topH - g;
    const colW = (1 - 2 * g) / 3;
    return [
      { slot: 1, pos: [0, 0], size: [1, topH] },
      { slot: 2, pos: [0, topH + g], size: [colW, stripH] },
      { slot: 3, pos: [colW + g, topH + g], size: [colW, stripH] },
      { slot: 4, pos: [2 * (colW + g), topH + g], size: [colW, stripH] },
    ];
  },
  corners: () => {
    const g = 0.012;
    const pipW = 0.17;
    const pipH = pipW; // 16:9 PiP on a 16:9 canvas
    return [
      { slot: 1, pos: [0.2, 0.06], size: [0.6, 0.88] },
      { slot: 2, pos: [1 - pipW - 0.02, 0.03], size: [pipW, pipH] },
      { slot: 3, pos: [1 - pipW - 0.02, 1 - pipH - 0.03], size: [pipW, pipH] },
      { slot: 4, pos: [0.02, 1 - pipH - 0.03], size: [pipW, pipH] },
    ];
  },
};

function applyTemplate(key) {
  if (!state.layout) { toast('Create or open a layout first', 'error'); return; }
  const make = TEMPLATES[key];
  if (!make) return;
  beginUndo();
  for (const t of make()) {
    const b = box(t.slot);
    if (!b) continue;
    b.pos = [...t.pos];
    b.size = [...t.size];
    if (t.enabled !== undefined) b.enabled = t.enabled;
    clampBox(b);
  }
  endUndo();
  for (let s = 1; s <= SLOT_COUNT(); s++) {
    renderBox(s);
    sendBox(s);
  }
  flushBox();
  syncSidebar();
}

// --- align / distribute ----------------------------------------------------

function enabledBoxes() {
  return (state.layout?.boxes || []).filter((b) => b.enabled);
}

function alignBoxes(mode) {
  const bs = enabledBoxes();
  if (bs.length < 2) { toast('Need at least two enabled boxes to align'); return; }
  beginUndo();
  if (mode === 'left') for (const b of bs) b.pos[0] = Math.min(...bs.map((x) => x.pos[0]));
  if (mode === 'right') for (const b of bs) b.pos[0] = Math.max(...bs.map((x) => x.pos[0] + x.size[0])) - b.size[0];
  if (mode === 'centerX') {
    const c = bs.reduce((s, b) => s + b.pos[0] + b.size[0] / 2, 0) / bs.length;
    for (const b of bs) b.pos[0] = c - b.size[0] / 2;
  }
  if (mode === 'top') for (const b of bs) b.pos[1] = Math.min(...bs.map((x) => x.pos[1]));
  if (mode === 'bottom') for (const b of bs) b.pos[1] = Math.max(...bs.map((x) => x.pos[1] + x.size[1])) - b.size[1];
  if (mode === 'centerY') {
    const c = bs.reduce((s, b) => s + b.pos[1] + b.size[1] / 2, 0) / bs.length;
    for (const b of bs) b.pos[1] = c - b.size[1] / 2;
  }
  endUndo();
  for (const b of bs) { clampBox(b); renderBox(b.slot); sendBox(b.slot); }
  flushBox();
  syncSidebar();
}

function distributeBoxes(axis) { // axis: 0 = x, 1 = y
  const bs = enabledBoxes().slice();
  if (bs.length < 3) { toast('Need at least three enabled boxes to distribute'); return; }
  beginUndo();
  bs.sort((a, b) => a.pos[axis] - b.pos[axis]);
  const first = bs[0];
  const last = bs[bs.length - 1];
  const span = (last.pos[axis] + last.size[axis]) - first.pos[axis];
  const totalSize = bs.reduce((s, b) => s + b.size[axis], 0);
  const gap = (span - totalSize) / (bs.length - 1);
  let cursor = first.pos[axis];
  for (const b of bs) {
    b.pos[axis] = cursor;
    cursor += b.size[axis] + gap;
  }
  endUndo();
  for (const b of bs) { renderBox(b.slot); sendBox(b.slot); }
  flushBox();
  syncSidebar();
}

// --- OBS live screenshot preview -------------------------------------------

let shotTimer = null;
function requestShot() {
  if (state.obs?.connected && state.layout) send({ type: 'screenshot' });
}
function startAutoShot() {
  clearInterval(shotTimer);
  if (!$('shotAuto').checked) return;
  shotTimer = setInterval(() => {
    if (!document.hidden && !interacting) requestShot();
  }, 2500);
}

// --- wire up controls ------------------------------------------------------

$('slot').addEventListener('change', () => selectBox(Number($('slot').value)));
$('enabled').addEventListener('change', () => {
  const b = box(selectedSlot);
  if (!b) return;
  beginUndo();
  b.enabled = $('enabled').checked;
  endUndo();
  renderBox(selectedSlot);
  renderLayers();
  sendBox(selectedSlot);
});
$('rotation').addEventListener('change', () => {
  const b = box(selectedSlot);
  if (!b) return;
  beginUndo();
  b.rotation = clamp(Number($('rotation').value) || 0, -180, 180);
  endUndo();
  renderBox(selectedSlot);
  sendBox(selectedSlot);
});
$('lockAspect').addEventListener('change', () => { lockAspect = $('lockAspect').checked; });

for (const [id, field, idx, dim] of [
  ['posX', 'pos', 0, W], ['posY', 'pos', 1, H],
  ['sizeW', 'size', 0, W], ['sizeH', 'size', 1, H],
  ['cropL', 'crop', 0, W], ['cropR', 'crop', 1, W],
  ['cropT', 'crop', 2, H], ['cropB', 'crop', 3, H],
]) {
  const el = $(id);
  el.addEventListener('focus', () => beginUndo());
  el.addEventListener('blur', () => endUndo());
  el.addEventListener('input', () => setField(field, idx, Number(el.value), dim()));
}

// style panel: sliders commit scope on pointerdown→change, inputs (numbers) on focus→blur
function styleControl(id, apply) {
  const el = $(id);
  el.addEventListener('pointerdown', () => beginUndo());
  el.addEventListener('focus', () => beginUndo());
  el.addEventListener('input', () => {
    const b = box(selectedSlot);
    if (!b) return;
    if (!b.style) b.style = defaultStyle();
    apply(b.style, el);
    renderBox(selectedSlot);
    sendBox(selectedSlot);
  });
  el.addEventListener('change', () => { endUndo(); syncSidebar(); });
  el.addEventListener('blur', () => endUndo());
}
styleControl('stRadius', (s, el) => { s.radius = Number(el.value); $('stRadiusV').textContent = el.value; });
styleControl('stOpacity', (s, el) => { s.opacity = Number(el.value) / 100; $('stOpacityV').textContent = el.value; });
styleControl('stBorderW', (s, el) => { s.border.width = Number(el.value); $('stBorderWV').textContent = el.value; });
styleControl('stBorderO', (s, el) => { s.border.opacity = Number(el.value) / 100; });
styleControl('stShadowO', (s, el) => { s.shadow.opacity = Number(el.value) / 100; $('stShadowOV').textContent = el.value; });
styleControl('stShadowBlur', (s, el) => { s.shadow.blur = Number(el.value); });
styleControl('stShadowSpread', (s, el) => { s.shadow.spread = Number(el.value); });
styleControl('stShadowX', (s, el) => { s.shadow.offsetX = Number(el.value); });
styleControl('stShadowY', (s, el) => { s.shadow.offsetY = Number(el.value); });
$('stBorderColor').addEventListener('input', () => {
  const b = box(selectedSlot);
  if (!b) return;
  beginUndo();
  b.style.border.color = $('stBorderColor').value;
  renderBox(selectedSlot);
  sendBox(selectedSlot);
});
$('stBorderColor').addEventListener('change', endUndo);
$('stShadowColor').addEventListener('input', () => {
  const b = box(selectedSlot);
  if (!b) return;
  beginUndo();
  b.style.shadow.color = $('stShadowColor').value;
  renderBox(selectedSlot);
  sendBox(selectedSlot);
});
$('stShadowColor').addEventListener('change', endUndo);

$('copyBtn').addEventListener('click', () => {
  const b = box(selectedSlot);
  if (b) clipboard = JSON.parse(JSON.stringify({ pos: b.pos, size: b.size, crop: b.crop, rotation: b.rotation, style: b.style }));
  toast('Box copied');
});
$('pasteBtn').addEventListener('click', () => {
  const b = box(selectedSlot);
  if (b && clipboard) {
    beginUndo();
    b.pos = [...clipboard.pos];
    b.size = [...clipboard.size];
    b.crop = [...clipboard.crop];
    b.rotation = clipboard.rotation || 0;
    b.style = JSON.parse(JSON.stringify(clipboard.style || defaultStyle()));
    clampBox(b);
    endUndo();
    renderBox(selectedSlot);
    syncSidebar();
    sendBox(selectedSlot);
  }
});

document.querySelectorAll('[data-align]').forEach((btn) => {
  btn.addEventListener('click', () => alignBoxes(btn.dataset.align));
});
$('distributeX').addEventListener('click', () => distributeBoxes(0));
$('distributeY').addEventListener('click', () => distributeBoxes(1));

$('newBtn').addEventListener('click', () => send({ type: 'newLayout', name: $('name').value || undefined }));
$('saveBtn').addEventListener('click', () => send({ type: 'save', name: $('name').value || undefined }));
$('openBtn').addEventListener('click', () => {
  const id = $('saved').value;
  if (id) send({ type: 'open', id });
});
$('dupBtn').addEventListener('click', () => {
  if (!state.layout) return;
  send({ type: 'newLayout', name: `${state.layout.name} copy`, from: state.layout.id });
});
$('deleteBtn').addEventListener('click', () => {
  const id = $('saved').value;
  const name = $('saved').selectedOptions[0]?.textContent;
  if (id && confirm(`Delete saved layout "${name}"? (Also removes its OBS scene.)`)) {
    send({ type: 'deleteLayout', id, name });
  }
});
$('takeBtn').addEventListener('click', () => send({ type: 'switch' }));
$('undoBtn').addEventListener('click', doUndo);
$('redoBtn').addEventListener('click', doRedo);
$('applyTemplateBtn').addEventListener('click', () => applyTemplate($('templateSel').value));

$('exportBtn').addEventListener('click', () => {
  if (!state.layout) return;
  const blob = new Blob([JSON.stringify(publicCopy(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.layout.id || 'layout'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('importFile').addEventListener('change', async () => {
  const f = $('importFile').files[0];
  if (!f) return;
  try {
    const layout = JSON.parse(await f.text());
    send({ type: 'importLayout', layout });
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error');
  }
  $('importFile').value = '';
});

$('bgUrl').addEventListener('change', () => {
  if (!state.layout) { toast('Create or open a layout first', 'error'); return; }
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
    const r = await authFetch('/api/bg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name, data }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    if (j.src) {
      $('bgUrl').value = j.src;
      send({ type: 'setBackground', src: j.src });
    }
  } catch (e) {
    toast(`Background upload failed: ${e.message}`, 'error');
  }
  $('bgFile').value = '';
});
$('bgClearBtn').addEventListener('click', () => {
  $('bgUrl').value = '';
  $('bgFile').value = '';
  if (state.layout) send({ type: 'setBackground', src: null });
});

$('shotBtn').addEventListener('click', requestShot);
$('shotAuto').addEventListener('change', startAutoShot);
$('shotOpacity').addEventListener('input', () => {
  $('obsPreview').style.opacity = Number($('shotOpacity').value) / 100;
});

// keyboard: arrows nudge, Del toggles, Ctrl+Z/Y undo/redo
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    doUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    doRedo();
    return;
  }
  if (typing || !state.layout) return;
  const b = box(selectedSlot);
  if (!b) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    beginUndo();
    b.enabled = !b.enabled;
    endUndo();
    renderBox(selectedSlot);
    renderLayers();
    sendBox(selectedSlot);
    syncSidebar();
    return;
  }
  const stepX = (e.shiftKey ? 10 : 1) / W();
  const stepY = (e.shiftKey ? 10 : 1) / H();
  let dx = 0, dy = 0;
  if (e.key === 'ArrowLeft') dx = -stepX;
  else if (e.key === 'ArrowRight') dx = stepX;
  else if (e.key === 'ArrowUp') dy = -stepY;
  else if (e.key === 'ArrowDown') dy = stepY;
  else return;
  e.preventDefault();
  beginUndo();
  beginInteract();
  b.pos = [clamp(b.pos[0] + dx, -(b.size[0] - 0.05), 0.95), clamp(b.pos[1] + dy, -(b.size[1] - 0.05), 0.95)];
  renderBox(selectedSlot);
  syncSidebar();
  showMeasures(selectedSlot);
  sendBox(selectedSlot);
  endInteract();
  endUndo();
});

window.addEventListener('resize', fitCanvas);

// --- go -------------------------------------------------------------------

updateObsChip();
connect();

function updateObsChip() {
  const chip = $('chipObs');
  if (!state.obs?.configured) {
    chip.textContent = 'OBS —';
    chip.className = 'chip';
    chip.title = 'OBS not configured (editor-only mode)';
  } else if (state.obs.connected) {
    chip.textContent = state.currentProgramScene
      ? `OBS ▸ ${state.currentProgramScene.replace(/^Super Source • Layout: /, '')}`
      : 'OBS ✓';
    chip.className = 'chip ok';
    chip.title = state.currentProgramScene || 'connected';
  } else {
    chip.textContent = 'OBS ✗';
    chip.className = 'chip bad';
    chip.title = 'OBS disconnected — retrying';
  }
}
