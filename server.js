import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';
import {
  connect, onConnectionClosed, isConnected, getVideoSettings, ensureSlots, getSceneList, slotNames,
  createLayout, setBoxTransform, setItemEnabled, reorderLayoutItems, removeScene, removeBackgroundInput,
  switchToProgram, ensureBackground, layoutName, getSourceScreenshot, enqueue,
} from './obs.js';
import { applySlotEffects, syncSlotEffects, cleanBoxEffects } from './effects.js';
import {
  blankLayout, nameToId, isValidId, normalizeLayout,
} from './layouts.js';
import { editorPort, bindAddress, editorToken, authEnabled, obsConfigured } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAYOUTS_DIR = path.join(__dirname, 'layouts');
const BGS_DIR = path.join(__dirname, 'bgs');
fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
fs.mkdirSync(BGS_DIR, { recursive: true });

const MASK_SHADER = fs.readFileSync(path.join(__dirname, 'shaders', 'boxfx_mask.shader'), 'utf8');
const SHADOW_SHADER = fs.readFileSync(path.join(__dirname, 'shaders', 'boxfx_shadow.shader'), 'utf8');
const MAX_BG_BYTES = 10 * 1024 * 1024;

const app = express();
app.use(express.json({ limit: '15mb' }));
// Never cache the UI assets — the editor changes often and stale JS causes confusing bugs.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// --- auth -------------------------------------------------------------------
// Editor UI + /bg images stay open; every /api route and the WebSocket require the
// token (URL query or Authorization: Bearer). Disable with EDITOR_TOKEN=''.
function requestToken(req) {
  if (!authEnabled) return true;
  const q = new URL(req.url, 'http://localhost').searchParams.get('token');
  const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return q === editorToken || h === editorToken;
}
app.use('/api', (req, res, next) => {
  if (requestToken(req)) return next();
  res.status(401).json({ error: 'unauthorized: missing or invalid token' });
});

// Background art: served to OBS as a browser source. Re-encoded at upload time, so
// only real images exist here (no HTML/SVG upload → no stored XSS).
app.use('/bg', express.static(BGS_DIR, { setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') }));

let canvas = { width: 1920, height: 1080 };
let current = null; // normalized layout + runtime fields (scene, items)

// --- persistence ---------------------------------------------------------

function layoutFile(id) {
  // id is validated against /^[a-z0-9][a-z0-9-]{0,63}$/ by every caller; this is
  // defense in depth for the path join itself.
  if (!isValidId(id)) throw new Error(`invalid layout id: ${JSON.stringify(String(id).slice(0, 40))}`);
  return path.join(LAYOUTS_DIR, `${id}.json`);
}

async function listSaved() {
  let files;
  try { files = await fs.promises.readdir(LAYOUTS_DIR); } catch { return []; }
  const out = [];
  for (const f of files.filter((n) => n.endsWith('.json'))) {
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(LAYOUTS_DIR, f), 'utf8'));
      out.push({ id: data.id || f.replace(/\.json$/, ''), name: data.name || data.id || f });
    } catch { /* corrupt file — surfaced by name only */ }
  }
  return out;
}

async function saveLayoutFile(layout) {
  const { id, name, version, boxes, bg, order } = layout;
  const file = layoutFile(id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify({ id, name, version, boxes, bg, order }, null, 2));
  await fs.promises.rename(tmp, file); // atomic on POSIX: no torn JSON files
  return id;
}

async function loadLayoutFile(id) {
  const data = JSON.parse(await fs.promises.readFile(layoutFile(id), 'utf8'));
  const layout = normalizeLayout(data);
  layout.id = id; // the filename is authoritative
  return layout;
}

// --- OBS sync ------------------------------------------------------------

async function applyLayoutToObs(layout) {
  // Editor-only mode (or OBS blip): keep the layout open locally, sync later on reconnect.
  if (!isConnected()) {
    layout.scene = layoutName(layout.name);
    layout.items = {};
    return;
  }
  const { scene, items } = await createLayout(layout.name);
  layout.scene = scene;
  layout.items = items;
  for (const b of layout.boxes) {
    if (items[b.slot] != null) {
      await enqueue(() => setBoxTransform(scene, items[b.slot], b, canvas));
      await enqueue(() => setItemEnabled(scene, items[b.slot], b.enabled));
    }
  }
  await enqueue(() => reorderLayoutItems(scene, items, layout.order));
  const bgUrl = layout.bg && layout.bg.src ? await resolveBg(layout.bg.src) : null;
  await enqueue(() => ensureBackground(layout, canvas, bgUrl));
  await enqueue(() => applySlotEffects(layout, canvas, MASK_SHADER, SHADOW_SHADER));
}

function publicLayout(l) {
  if (!l) return null;
  const { id, name, boxes, bg, order, version } = l;
  return { id, name, boxes, bg, order, version };
}

// Generate a non-colliding name for a brand-new layout.
async function uniqueName(base) {
  const ids = new Set((await listSaved()).map((s) => s.id));
  if (!ids.has(nameToId(base))) return base;
  let i = 2;
  while (ids.has(nameToId(`${base} ${i}`))) i++;
  return `${base} ${i}`;
}

// Debounced auto-save: persists the current layout shortly after edits stop.
let autoSaveTimer = null;
function scheduleAutosave() {
  if (!current || !current.id) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveLayoutFile(current).catch((e) => console.warn('[server] autosave failed:', e.message));
  }, 700);
}

// --- background upload -----------------------------------------------------

async function resolveBg(src) {
  if (!src) return null;
  if (/^https?:\/\//.test(src)) return src;
  const file = path.join(BGS_DIR, path.basename(src));
  try {
    const buf = await sharp(file)
      .resize(canvas.width, canvas.height, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 85 })
      .toBuffer();
    // Cache-busting fragment: OBS browser sources don't reload on SetInputSettings
    // unless the URL string changes, so a changing fragment forces a refresh.
    return `data:image/jpeg;base64,${buf.toString('base64')}#v${Date.now()}`;
  } catch (e) {
    console.warn('[bg] sharp failed for', file, e.message);
    return null;
  }
}

app.post('/api/bg', async (req, res) => {
  try {
    const { name, data } = req.body || {};
    if (!name || !data) return res.status(400).json({ error: 'name and data required' });
    const buf = Buffer.from(String(data), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'data is not valid base64' });
    if (buf.length > MAX_BG_BYTES) return res.status(413).json({ error: 'image too large (max 10 MB)' });
    // Re-encode through sharp: rejects non-images, strips metadata/payloads, and the
    // stored file is always a JPEG served as image/jpeg.
    const stem = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80).replace(/\.[^.]*$/, '').replace(/^\.+/, '') || 'bg';
    const file = `${stem}-${Date.now()}.jpg`;
    await sharp(buf)
      .resize(3840, 3840, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toFile(path.join(BGS_DIR, file));
    res.json({ src: `/bg/${encodeURIComponent(file)}` });
  } catch (e) {
    res.status(400).json({ error: `invalid image: ${e.message}` });
  }
});

app.delete('/api/bg/:name', async (req, res) => {
  const name = path.basename(String(req.params.name));
  try {
    await fs.promises.unlink(path.join(BGS_DIR, name));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'no such background' });
  }
});

// --- WS ------------------------------------------------------------------

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
}

async function statePayload() {
  let currentProgramScene = null;
  if (isConnected()) {
    try {
      ({ currentProgramSceneName: currentProgramScene } = await getSceneList());
    } catch { /* stale state is fine */ }
  }
  return {
    type: 'state',
    canvas,
    slots: slotNames,
    saved: await listSaved(),
    layout: publicLayout(current),
    currentProgramScene,
    obs: { connected: isConnected(), configured: obsConfigured },
  };
}

function requireCurrent(ws) {
  if (!current) {
    send(ws, { type: 'error', error: 'no layout open — create or open one first' });
    return false;
  }
  return true;
}

async function onMessage(ws, msg) {
  switch (msg.type) {
    case 'hello':
      send(ws, await statePayload());
      break;

    case 'newLayout': {
      const name = await uniqueName(msg.name || 'Layout');
      current = msg.from ? await loadLayoutFile(msg.from) : blankLayout(name);
      if (msg.from) { current.name = name; current.id = nameToId(name); }
      try { await applyLayoutToObs(current); } catch (e) { send(ws, { type: 'error', error: `OBS sync failed: ${e.message}` }); }
      await saveLayoutFile(current);
      send(ws, { type: 'layout', layout: publicLayout(current) });
      broadcast({ type: 'saved', saved: await listSaved() });
      break;
    }

    case 'open': {
      try {
        current = await loadLayoutFile(msg.id);
        try { await applyLayoutToObs(current); } catch (e) { send(ws, { type: 'error', error: `OBS sync failed: ${e.message}` }); }
        send(ws, { type: 'layout', layout: publicLayout(current) });
      } catch (e) {
        send(ws, { type: 'error', error: `Could not open layout: ${e.message}` });
      }
      break;
    }

    // Full replace of the current layout (templates, import, undo/redo).
    case 'setLayout': {
      if (!requireCurrent(ws)) break;
      const next = normalizeLayout({ ...msg.layout, id: current.id, name: msg.layout?.name || current.name });
      current = next;
      try { await applyLayoutToObs(current); } catch (e) { send(ws, { type: 'error', error: `OBS sync failed: ${e.message}` }); }
      send(ws, { type: 'layout', layout: publicLayout(current) });
      scheduleAutosave();
      break;
    }

    case 'importLayout': {
      const layout = normalizeLayout(msg.layout || {});
      layout.name = await uniqueName(layout.name);
      layout.id = nameToId(layout.name);
      current = layout;
      try { await applyLayoutToObs(current); } catch (e) { send(ws, { type: 'error', error: `OBS sync failed: ${e.message}` }); }
      await saveLayoutFile(current);
      send(ws, { type: 'layout', layout: publicLayout(current) });
      broadcast({ type: 'saved', saved: await listSaved() });
      break;
    }

    case 'save': {
      if (!requireCurrent(ws)) break;
      const oldId = current.id;
      if (msg.name) { current.name = String(msg.name).slice(0, 80); current.id = nameToId(current.name); }
      await saveLayoutFile(current);
      if (msg.name && current.id !== oldId) {
        // renamed: drop the stale file under the old id
        try { await fs.promises.unlink(layoutFile(oldId)); } catch { /* wasn't saved yet */ }
      }
      send(ws, { type: 'saved', id: current.id, name: current.name, saved: await listSaved() });
      break;
    }

    case 'deleteLayout': {
      try {
        await fs.promises.unlink(layoutFile(msg.id));
      } catch (e) {
        send(ws, { type: 'error', error: `Could not delete: ${e.message}` });
        break;
      }
      const name = String(msg.name || msg.id);
      try { await enqueue(() => removeScene(layoutName(name))); } catch { /* scene absent */ }
      try { await enqueue(() => removeBackgroundInput(name)); } catch { /* input absent */ }
      broadcast({ type: 'saved', id: null, saved: await listSaved() });
      break;
    }

    case 'setBox': {
      if (!requireCurrent(ws)) break;
      const { slot, box } = msg;
      const idx = current.boxes.findIndex((b) => b.slot === slot);
      if (idx < 0) { send(ws, { type: 'error', error: `no slot ${slot}` }); break; }
      const prevEnabled = current.boxes[idx].enabled;
      current.boxes[idx] = { ...current.boxes[idx], ...box, slot };
      normalizeLayout(current); // revalidates every box (incl. style) in place
      const full = current.boxes[idx];
      if (isConnected() && current.items && current.items[slot] != null) {
        await enqueue(() => setBoxTransform(current.scene, current.items[slot], full, canvas));
        if (full.enabled !== prevEnabled) {
          await enqueue(() => setItemEnabled(current.scene, current.items[slot], full.enabled));
        }
      }
      if (isConnected()) {
        await enqueue(() => syncSlotEffects(current, slot, canvas, MASK_SHADER, SHADOW_SHADER));
      }
      send(ws, { type: 'box', slot, box: full });
      scheduleAutosave();
      break;
    }

    // order: slot numbers bottom → top (index 0 stays the background).
    case 'reorder': {
      if (!requireCurrent(ws)) break;
      const order = Array.isArray(msg.order) ? msg.order.map(Number) : [];
      const valid = order.filter((s) => current.boxes.some((b) => b.slot === s));
      for (const b of current.boxes) if (!valid.includes(b.slot)) valid.push(b.slot);
      current.order = valid;
      if (current.scene && current.items) {
        await enqueue(() => reorderLayoutItems(current.scene, current.items, current.order));
      }
      send(ws, { type: 'layout', layout: publicLayout(current) });
      scheduleAutosave();
      break;
    }

    case 'setBackground': {
      if (!requireCurrent(ws)) break;
      current.bg = msg.src ? { src: String(msg.src).slice(0, 500) } : null;
      if (isConnected()) {
        try {
          const bgUrl = current.bg ? await resolveBg(current.bg.src) : null;
          await enqueue(() => ensureBackground(current, canvas, bgUrl));
        } catch (e) {
          send(ws, { type: 'error', error: `OBS sync failed: ${e.message}` });
        }
      }
      send(ws, { type: 'layout', layout: publicLayout(current) });
      scheduleAutosave();
      break;
    }

    case 'switch': {
      if (!requireCurrent(ws)) break;
      await enqueue(() => switchToProgram(current.scene));
      send(ws, { type: 'switched', scene: current.scene });
      broadcast({ type: 'switched', scene: current.scene });
      break;
    }

    case 'switchSaved': {
      // Apply (creating the scene if needed) then put on program, without replacing
      // the layout open in the editor.
      try {
        const layout = await loadLayoutFile(msg.id);
        await applyLayoutToObs(layout);
        await enqueue(() => switchToProgram(layout.scene));
        send(ws, { type: 'switched', scene: layout.scene });
        broadcast({ type: 'switched', scene: layout.scene });
      } catch (e) {
        send(ws, { type: 'error', error: `Could not switch: ${e.message}` });
      }
      break;
    }

    case 'screenshot': {
      try {
        if (!isConnected()) throw new Error('OBS is not connected');
        const scene = msg.scene || current?.scene;
        if (!scene) throw new Error('no layout open');
        const data = await getSourceScreenshot(scene, { format: 'jpeg', quality: 70, width: 1280 });
        send(ws, { type: 'screenshot', data });
      } catch (e) {
        send(ws, { type: 'error', error: `screenshot failed: ${e.message}` });
      }
      break;
    }

    default:
      send(ws, { type: 'error', error: `unknown message type: ${String(msg.type).slice(0, 40)}` });
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (!requestToken({ url: req.url, headers: req.headers })) {
    send(ws, { type: 'error', error: 'unauthorized: missing or invalid token' });
    ws.close(4001, 'unauthorized');
    return;
  }
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { send(ws, { type: 'error', error: 'invalid JSON' }); return; }
    onMessage(ws, msg).catch((e) => send(ws, { type: 'error', error: e?.message || String(e) }));
  });
});

app.get('/api/state', async (_req, res) => res.json(await statePayload()));

// Connect to OBS with timeout + retry, re-applying the current layout on (re)connect.
// With no OBS credentials the server runs in editor-only mode (layouts still save).
let connecting = false;
let effectsCleaned = false;
async function connectLoop() {
  if (connecting) return;
  connecting = true;
  try {
    while (true) {
      try {
        await Promise.race([
          connect(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('OBS connect timeout')), 8000)),
        ]);
        const v = await getVideoSettings();
        canvas = { width: v.baseWidth, height: v.baseHeight };
        console.log(`[obs] connected; canvas ${canvas.width}x${canvas.height}`);
        await ensureSlots();
        if (!effectsCleaned) { await cleanBoxEffects(); effectsCleaned = true; }
        console.log('[obs] slots ready');
        broadcast({ type: 'obsStatus', connected: true, configured: true });
        if (current) {
          try { await applyLayoutToObs(current); } catch (e) { console.warn('[obs] reapply failed:', e.message); }
        }
        return;
      } catch (e) {
        broadcast({ type: 'obsStatus', connected: false, configured: true });
        console.error('[obs] connect failed, retrying in 3s:', e?.message || e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } finally {
    connecting = false;
  }
}

async function main() {
  // Serve the UI immediately, even before OBS is reachable.
  server.listen(editorPort, bindAddress, () => {
    const display = bindAddress === '0.0.0.0' ? `<this-host-ip>` : bindAddress;
    console.log(`[server] editor: http://localhost:${editorPort} (also bound to ${display})`);
    if (authEnabled) {
      console.log(`[server] token: ${editorToken}`);
      console.log(`[server] quick open: http://localhost:${editorPort}/?token=${editorToken}`);
    } else {
      console.log('[server] auth DISABLED (EDITOR_TOKEN="") — anyone on the network can control this app');
    }
  });
  onConnectionClosed(() => { console.log('[obs] lost — reconnecting…'); connectLoop(); });
  if (obsConfigured) {
    connectLoop();
  } else {
    console.log('[server] OBS not configured (no credentials.md / env vars) — editor-only mode');
  }
}

main().catch((e) => {
  console.error('[server] startup failed:', e?.message || e);
  process.exit(1);
});
