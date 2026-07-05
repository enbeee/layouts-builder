import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';
import {
  connect, onConnectionClosed, getVideoSettings, ensureSlots, getSceneList, slotNames,
  createLayout, setBoxTransform, setItemEnabled, removeScene, switchToProgram, ensureBackground,
  layoutName,
} from './obs.js';
import { applySourceEffects, updateSlotCrop, cleanBoxEffects } from './effects.js';
import { blankLayout, nameToId, normalizeBoxes, clampCrop } from './layouts.js';
import { editorPort, overlayBaseUrl } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAYOUTS_DIR = path.join(__dirname, 'layouts');
fs.mkdirSync(LAYOUTS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '25mb' }));
// Never cache the UI assets — the editor changes often and stale JS causes confusing bugs.
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// Background art: served to OBS as a browser source.
const BGS_DIR = path.join(__dirname, 'bgs');
fs.mkdirSync(BGS_DIR, { recursive: true });
const BOXFX_SHADER = fs.readFileSync(path.join(__dirname, 'shaders', 'boxfx_chroma.shader'), 'utf8');
app.use('/bg', express.static(BGS_DIR));

// Resolve a background src into a data: URL the OBS browser source can render with no
// network fetch. Uploaded images are resized to the canvas (cover) via sharp so they
// fill the frame at any original dimensions; http(s) URLs pass through as-is.
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
app.post('/api/bg', (req, res) => {
  const { name, data } = req.body || {};
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  try {
    fs.writeFileSync(path.join(BGS_DIR, safe), Buffer.from(data, 'base64'));
    res.json({ src: `/bg/${encodeURIComponent(safe)}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let canvas = { width: 1920, height: 1080 };
let current = null; // { id, name, boxes, scene, items }

// --- persistence ---------------------------------------------------------

function layoutFile(id) {
  return path.join(LAYOUTS_DIR, `${id}.json`);
}

function listSaved() {
  return fs.readdirSync(LAYOUTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(LAYOUTS_DIR, f), 'utf8'));
        return { id: data.id || f.replace(/\.json$/, ''), name: data.name || data.id || f };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function saveLayoutFile(layout) {
  const { id, name, boxes, bg, effects } = layout;
  fs.writeFileSync(layoutFile(id), JSON.stringify({ id, name, boxes, bg, effects }, null, 2));
  return id;
}

function loadLayoutFile(id) {
  const data = JSON.parse(fs.readFileSync(layoutFile(id), 'utf8'));
  data.id = id;
  data.boxes = normalizeBoxes(data);
  data.boxes.forEach(clampCrop);
  data.bg = data.bg && data.bg.src ? data.bg : null;
  data.effects = data.effects || null;
  return data;
}

// --- OBS sync ------------------------------------------------------------

async function applyLayoutToObs(layout) {
  const { scene, items } = await createLayout(layout.name);
  layout.scene = scene;
  layout.items = items;
  for (const b of layout.boxes) {
    clampCrop(b);
    if (items[b.slot] != null) {
      await setBoxTransform(scene, items[b.slot], b, canvas);
      await setItemEnabled(scene, items[b.slot], b.enabled);
    }
  }
  await ensureBackground(layout, canvas, layout.bg && layout.bg.src ? await resolveBg(layout.bg.src) : null);
  if (layout.effects) await applySourceEffects(layout, canvas, BOXFX_SHADER);
}

function publicLayout(l) {
  if (!l) return null;
  const { id, name, boxes, bg, effects } = l;
  return { id, name, boxes, bg, effects };
}

// Generate a non-colliding name for a brand-new layout.
function uniqueName(base) {
  const ids = new Set(listSaved().map((s) => s.id));
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
    try { saveLayoutFile(current); } catch (e) { console.warn('[server] autosave failed:', e.message); }
  }, 700);
}

function broadcastSaved() {
  const msg = JSON.stringify({ type: 'saved', saved: listSaved() });
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
}

// --- WS ------------------------------------------------------------------

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

async function statePayload() {
  let currentProgramScene = null;
  try {
    ({ currentProgramSceneName: currentProgramScene } = await getSceneList());
  } catch { /* ignore */ }
  return {
    type: 'state',
    canvas,
    slots: slotNames,
    saved: listSaved(),
    layout: publicLayout(current),
    currentProgramScene,
  };
}

async function onMessage(ws, msg) {
  switch (msg.type) {
    case 'hello':
      send(ws, await statePayload());
      break;

    case 'newLayout': {
      const name = uniqueName(msg.name || 'Layout');
      current = blankLayout(name);
      await applyLayoutToObs(current);
      saveLayoutFile(current);
      send(ws, { type: 'layout', layout: publicLayout(current) });
      broadcastSaved();
      break;
    }

    case 'open': {
      try {
        current = loadLayoutFile(msg.id);
        await applyLayoutToObs(current);
        send(ws, { type: 'layout', layout: publicLayout(current) });
      } catch (e) {
        send(ws, { type: 'error', error: `Could not open layout: ${e.message}` });
      }
      break;
    }

    case 'save': {
      if (!current) break;
      if (msg.name) { current.name = msg.name; current.id = nameToId(msg.name); }
      saveLayoutFile(current);
      send(ws, { type: 'saved', id: current.id, name: current.name, saved: listSaved() });
      break;
    }

    case 'deleteLayout': {
      try { fs.unlinkSync(layoutFile(msg.id)); } catch { /* ignore */ }
      try { await removeScene(layoutName(msg.name || msg.id)); } catch { /* ignore */ }
      send(ws, { type: 'saved', id: null, saved: listSaved() });
      break;
    }

    case 'setBox': {
      if (!current) break;
      const { slot, box } = msg;
      const idx = current.boxes.findIndex((b) => b.slot === slot);
      if (idx < 0) break;
      const prevEnabled = current.boxes[idx].enabled;
      current.boxes[idx] = { ...current.boxes[idx], ...box, slot };
      const full = current.boxes[idx];
      clampCrop(full);
      if (current.items && current.items[slot] != null) {
        await setBoxTransform(current.scene, current.items[slot], full, canvas);
        if (full.enabled !== prevEnabled) await setItemEnabled(current.scene, current.items[slot], full.enabled);
      }
      send(ws, { type: 'box', slot, box: full });
      if (current.effects && (current.effects.corner_radius || current.effects.border_width)) {
        await updateSlotCrop(current, slot, canvas);
      }
      scheduleAutosave();
      break;
    }

    case 'setBackground': {
      if (!current) break;
      current.bg = msg.src ? { src: msg.src } : null;
      await ensureBackground(current, canvas, current.bg ? await resolveBg(current.bg.src) : null);
      send(ws, { type: 'layout', layout: publicLayout(current) });
      scheduleAutosave();
      break;
    }

    case 'setEffects': {
      if (!current) break;
      current.effects = current.effects || {};
      Object.assign(current.effects, msg.effects);
      await applySourceEffects(current, canvas, BOXFX_SHADER);
      send(ws, { type: 'layout', layout: publicLayout(current) });
      scheduleAutosave();
      break;
    }

    case 'switch': {
      if (!current) break;
      await switchToProgram(current.scene);
      send(ws, { type: 'switched', scene: current.scene });
      break;
    }

    case 'switchSaved': {
      // Apply (creating the scene if needed) then put on program, without replacing
      // the layout open in the editor.
      try {
        const layout = loadLayoutFile(msg.id);
        await applyLayoutToObs(layout);
        await switchToProgram(layout.scene);
        send(ws, { type: 'switched', scene: layout.scene });
      } catch (e) {
        send(ws, { type: 'error', error: `Could not switch: ${e.message}` });
      }
      break;
    }

    default:
      break;
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    onMessage(ws, msg).catch((e) => send(ws, { type: 'error', error: e?.message || String(e) }));
  });
});

app.get('/api/state', async (_req, res) => res.json(await statePayload()));

// Connect to OBS with timeout + retry, re-applying the current layout on (re)connect.
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
        if (current) {
          try { await applyLayoutToObs(current); } catch (e) { console.warn('[obs] reapply failed:', e.message); }
        }
        return;
      } catch (e) {
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
  server.listen(editorPort, () => console.log(`[server] editor: http://localhost:${editorPort}`));
  onConnectionClosed(() => { console.log('[obs] lost — reconnecting…'); connectLoop(); });
  connectLoop();
}

main().catch((e) => {
  console.error('[server] startup failed:', e?.message || e);
  process.exit(1);
});
