// Thin wrapper around obs-websocket-js. All OBS calls live here so the rest of the
// app stays decoupled from the protocol. The password comes from config (server-side only).
import OBSWebSocket from 'obs-websocket-js';
import { obsUrl, obsPassword } from './config.js';

export const SLOT_PREFIX = 'Super Source • Slot ';
export const SLOT_COUNT = 4;
export const LAYOUT_PREFIX = 'Super Source • Layout: ';

export const slotName = (n) => `${SLOT_PREFIX}${n}`;
export const slotNames = Array.from({ length: SLOT_COUNT }, (_, i) => slotName(i + 1));
export const layoutName = (name) => `${LAYOUT_PREFIX}${name}`;

// OBS alignment: CENTER = 0 (LEFT=1, RIGHT=2, TOP=4, BOTTOM=8).
const OBS_ALIGN_CENTER = 0;

let obs = null;
let onClose = null;

export function onConnectionClosed(cb) {
  onClose = cb;
}

export function getClient() {
  if (!obs) throw new Error('OBS client not connected');
  return obs;
}

export async function connect() {
  obs = new OBSWebSocket();

  obs.on('ConnectionOpened', () => console.log('[obs] connection opened'));
  obs.on('Identified', () => console.log('[obs] identified'));
  obs.on('ConnectionClosed', () => {
    console.warn('[obs] connection closed');
    obs = null;
    onClose?.();
  });
  obs.on('error', (e) => console.error('[obs] error:', e?.message || e));

  await obs.connect(obsUrl, obsPassword);
  return obs;
}

export async function getVideoSettings() {
  // { baseWidth, baseHeight, fpsNumerator, fpsDenominator }
  return obs.call('GetVideoSettings');
}

export async function getSceneList() {
  // { scenes: [{ sceneName, sceneIndex, sceneUuid }], currentProgramSceneName, ... }
  return obs.call('GetSceneList');
}

export async function sceneExists(name) {
  const { scenes } = await obs.call('GetSceneList');
  return scenes.some((s) => s.sceneName === name);
}

export async function ensureScene(name) {
  if (await sceneExists(name)) return false;
  await obs.call('CreateScene', { sceneName: name });
  console.log(`[obs] created scene "${name}"`);
  return true;
}

export async function ensureSlots() {
  const created = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    if (await ensureScene(slotName(i))) created.push(slotName(i));
  }
  return created;
}

// --- Layout scenes ---------------------------------------------------------

// Return the scene item id of `sourceName` within `sceneName`, adding it if absent.
export async function getOrAddSceneItem(sceneName, sourceName) {
  try {
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName });
    if (sceneItemId) return sceneItemId;
  } catch {
    /* not present */
  }
  const { sceneItemId } = await obs.call('CreateSceneItem', {
    sceneName,
    sourceName,
    sceneItemEnabled: true,
  });
  return sceneItemId;
}

// Ensure a layout scene exists with the 4 slots added as items; return { scene, items }.
export async function createLayout(layoutLabel) {
  const scene = layoutName(layoutLabel);
  await ensureScene(scene);
  const items = {};
  for (let i = 0; i < SLOT_COUNT; i++) {
    items[i + 1] = await getOrAddSceneItem(scene, slotNames[i]);
  }
  return { scene, items };
}

// box: { pos:[px,py], size:[sw,sh], crop:[cl,cr,ct,cb], enabled:bool } — all normalized 0..1.
// pos = top-left of the box CONTAINER. The source is fit into the container with its
// aspect preserved and centered (SCALE_INNER bounds + center alignment), so video is
// never stretched. positionX/Y point at the container's center. Only the transform is
// set here (a clean partial update, no read-back) to keep OBS work per edit minimal;
// the caller toggles `enabled` separately only when it changes.
export async function setBoxTransform(sceneName, itemId, box, canvas) {
  const [px, py] = box.pos;
  const [sw, sh] = box.size;
  const [cl, cr, ct, cb] = box.crop;
  const transform = {
    alignment: OBS_ALIGN_CENTER,
    positionX: (px + sw / 2) * canvas.width,
    positionY: (py + sh / 2) * canvas.height,
    boundsType: 'OBS_BOUNDS_SCALE_INNER',
    boundsAlignment: OBS_ALIGN_CENTER,
    boundsWidth: sw * canvas.width,
    boundsHeight: sh * canvas.height,
    rotation: 0,
    cropLeft: Math.round(cl * canvas.width),
    cropTop: Math.round(ct * canvas.height),
    cropRight: Math.round(cr * canvas.width),
    cropBottom: Math.round(cb * canvas.height),
  };
  await obs.call('SetSceneItemTransform', { sceneName, sceneItemId: itemId, sceneItemTransform: transform });
  return transform;
}

export async function setItemEnabled(sceneName, itemId, enabled) {
  await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: itemId, sceneItemEnabled: !!enabled });
}

export async function removeScene(name) {
  await obs.call('RemoveScene', { sceneName: name });
}

export async function switchToProgram(sceneName) {
  await obs.call('SetCurrentProgramScene', { sceneName });
}

// --- box effects (shaderfilter on the LAYOUT scene) -----------------------

const FX_FILTER = 'Box Effects';

// Compute the visible content rectangle (pixel edges) for a box, accounting for
// crop and SCALE_INNER fit. Returns zeros if disabled.
function boxRect(b, canvas) {
  if (!b || !b.enabled) return { l: 0, t: 0, r: 0, b: 0 };
  const [px, py] = b.pos;
  const [sw, sh] = b.size;
  const [cl, cr, ct, cb] = b.crop || [0, 0, 0, 0];

  const boxL = px * canvas.width;
  const boxT = py * canvas.height;
  const boxW = sw * canvas.width;
  const boxH = sh * canvas.height;

  // Cropped source dimensions
  const srcW = Math.max(1, (1 - cl - cr) * canvas.width);
  const srcH = Math.max(1, (1 - ct - cb) * canvas.height);

  // SCALE_INNER: fit cropped source inside box, preserve aspect, center
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const contentW = srcW * scale;
  const contentH = srcH * scale;
  const contentL = boxL + (boxW - contentW) / 2;
  const contentT = boxT + (boxH - contentH) / 2;

  return { l: contentL, t: contentT, r: contentL + contentW, b: contentT + contentH };
}

// Apply the layout-level box-effects shader. Always recreates the filter to ensure
// the correct shader version is loaded. Called on open/switchSaved/setEffects.
export async function applyBoxEffects(layout, canvas, shaderText) {
  if (!layout || !layout.scene) return;
  const scene = layout.scene;
  const effects = layout.effects || {};
  const radius = Number(effects.corner_radius) || 0;
  const border = Number(effects.border_width) || 0;
  const color = Number(effects.border_color) || 0xFFFFFFFF;
  const enabled = radius > 0 || border > 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Remove old filter (forces fresh shader load)
  try { await obs.call('RemoveSourceFilter', { sourceName: scene, filterName: FX_FILTER }); } catch { /* ignore */ }

  if (!enabled) return;

  // Create + load shader + set ALL uniforms in one go (avoid breaking recompile
  // by doing a separate uniforms-only call after shader_text)
  await obs.call('CreateSourceFilter', { sourceName: scene, filterName: FX_FILTER, filterKind: 'shader_filter' });
  await obs.call('SetSourceFilterSettings', { sourceName: scene, filterName: FX_FILTER, filterSettings: { override_entire_effect: false, from_file: false } });
  await sleep(200);

  // Everything in one call: shader_text + all uniforms together
  const allSettings = {
    override_entire_effect: false, from_file: false,
    shader_text: shaderText,
    corner_radius: radius, border_width: border, border_color: color,
    canvas_w: canvas.width, canvas_h: canvas.height,
  };
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const b = (layout.boxes || []).find((x) => x.slot === i);
    const r = boxRect(b, canvas);
    allSettings[`b${i}_l`] = r.l; allSettings[`b${i}_t`] = r.t; allSettings[`b${i}_r`] = r.r; allSettings[`b${i}_b`] = r.b;
  }
  await obs.call('SetSourceFilterSettings', { sourceName: scene, filterName: FX_FILTER, filterSettings: allSettings });
  await sleep(1000);
  await obs.call('SetSourceFilterEnabled', { sourceName: scene, filterName: FX_FILTER, filterEnabled: true });
}

// Fast update of box geometry uniforms (called when a box moves/resizes/crops).
export async function updateBoxLayout(layout, slot, canvas) {
  if (!layout || !layout.scene) return;
  try {
    const { filters } = await obs.call('GetSourceFilterList', { sourceName: layout.scene });
    if (!filters.some((f) => f.filterName === FX_FILTER)) return;
    const b = (layout.boxes || []).find((x) => x.slot === slot);
    const r = boxRect(b, canvas);
    await obs.call('SetSourceFilterSettings', { sourceName: layout.scene, filterName: FX_FILTER, filterSettings: {
      [`b${slot}_l`]: r.l, [`b${slot}_t`]: r.t, [`b${slot}_r`]: r.r, [`b${slot}_b`]: r.b,
    }});
  } catch { /* filter doesn't exist */ }
}

// Remove all Box Effects filters from ALL scenes (cleanup on startup).
export async function cleanBoxEffects() {
  const { scenes } = await obs.call('GetSceneList');
  for (const sc of scenes) {
    try { await obs.call('RemoveSourceFilter', { sourceName: sc.sceneName, filterName: FX_FILTER }); } catch { /* ignore */ }
  }
}

// --- background layer (browser source behind the slots) -------------------

export async function findSceneItemId(sceneName, sourceName) {
  try {
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName });
    return sceneItemId || null;
  } catch {
    return null;
  }
}

// Ensure a full-canvas background browser source sits behind the slots.
// layout.bg.src is either an absolute URL or a server-relative path (e.g. /bg/x.png).
// `url` is a data: URL (image pre-resized to canvas) or an http(s) URL, or null.
// The browser source is created at canvas size and stretched to fill, so it always
// covers the frame. Reuses an existing/orphan input to avoid OBS auto-renaming.
export async function ensureBackground(layout, canvas, url) {
  if (!layout || !layout.scene) return;
  const scene = layout.scene;
  const name = `Super Source • BG: ${layout.name}`;
  const settings = { url, width: Number(canvas.width), height: Number(canvas.height) };

  let itemId = await findSceneItemId(scene, name);
  if (url) {
    if (!itemId) {
      let exists = false;
      try { await obs.call('GetInputSettings', { inputName: name }); exists = true; } catch { /* none */ }
      if (exists) {
        try { await obs.call('SetInputSettings', { inputName: name, inputSettings: settings, overlay: true }); } catch { /* ignore */ }
        itemId = (await obs.call('CreateSceneItem', { sceneName: scene, sourceName: name, sceneItemEnabled: true })).sceneItemId;
      } else {
        itemId = (await obs.call('CreateInput', {
          sceneName: scene, inputName: name, inputKind: 'browser_source',
          inputSettings: settings, sceneItemEnabled: true,
        })).sceneItemId;
      }
      await obs.call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: itemId,
        sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_STRETCH', boundsWidth: canvas.width, boundsHeight: canvas.height, alignment: 5, boundsAlignment: 5 },
      });
    } else {
      try { await obs.call('SetInputSettings', { inputName: name, inputSettings: settings, overlay: true }); } catch { /* ignore */ }
    }
    await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: itemId, sceneItemEnabled: true });
    try { await obs.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: itemId, sceneItemIndex: 0 }); } catch { /* ignore */ }
    layout.bgItemId = itemId;
  } else {
    if (itemId) { try { await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: itemId, sceneItemEnabled: false }); } catch { /* ignore */ } }
    layout.bgItemId = null;
  }
}

