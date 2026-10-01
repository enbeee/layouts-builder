// Thin wrapper around obs-websocket-js. All OBS calls live here so the rest of the
// app stays decoupled from the protocol. The password comes from config (server-side
// only). Mutating calls are serialized through a promise queue so rapid editor edits
// can't interleave OBS request/response pairs.
import OBSWebSocket from 'obs-websocket-js';
import { obsUrl, obsPassword } from './config.js';

export const SLOT_PREFIX = 'Super Source • Slot ';
export const SLOT_COUNT = Number(process.env.SLOT_COUNT) || 4;
export const LAYOUT_PREFIX = 'Super Source • Layout: ';

export const slotName = (n) => `${SLOT_PREFIX}${n}`;
export const slotNames = Array.from({ length: SLOT_COUNT }, (_, i) => slotName(i + 1));
export const layoutName = (name) => `${LAYOUT_PREFIX}${name}`;

// OBS alignment: CENTER = 0 (LEFT=1, RIGHT=2, TOP=4, BOTTOM=8).
const OBS_ALIGN_CENTER = 0;

let obs = null;
let onClose = null;

// Serialize state-changing OBS operations: every queued fn runs to completion before
// the next one starts, even if earlier ones failed.
let chain = Promise.resolve();
export function enqueue(fn) {
  const run = chain.then(fn);
  chain = run.then(() => {}, () => {});
  return run;
}

export function onConnectionClosed(cb) {
  onClose = cb;
}

export function getClient() {
  if (!obs) throw new Error('OBS client not connected');
  return obs;
}

export function isConnected() {
  return !!obs;
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
  const existing = await findSceneItemId(sceneName, sourceName);
  if (existing) return existing;
  const { sceneItemId } = await obs.call('CreateSceneItem', {
    sceneName,
    sourceName,
    sceneItemEnabled: true,
  });
  return sceneItemId;
}

// Ensure a layout scene exists with the slots added as items; return { scene, items }.
export async function createLayout(layoutLabel) {
  const scene = layoutName(layoutLabel);
  await ensureScene(scene);
  const items = {};
  for (let i = 0; i < SLOT_COUNT; i++) {
    items[i + 1] = await getOrAddSceneItem(scene, slotNames[i]);
  }
  return { scene, items };
}

export async function findSceneItemId(sceneName, sourceName) {
  try {
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName });
    return sceneItemId || null;
  } catch {
    return null;
  }
}

// box: { pos:[px,py], size:[sw,sh], crop:[cl,cr,ct,cb], enabled:bool, rotation?:deg }
// — pos/size/crop normalized 0..1. pos = top-left of the box CONTAINER. The cropped
// content is fit into the container with its aspect preserved and centered
// (SCALE_INNER bounds + center alignment), so video is never stretched. positionX/Y
// point at the container's center.
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
    rotation: Number(box.rotation) || 0,
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

// order: slot numbers bottom → top. Index 0 stays reserved for the background item.
export async function reorderLayoutItems(sceneName, items, order) {
  let idx = 1;
  for (const slot of order) {
    const itemId = items[slot];
    if (itemId == null) continue;
    try { await obs.call('SetSceneItemIndex', { sceneName, sceneItemId: itemId, sceneItemIndex: idx }); } catch { /* ignore */ }
    idx++;
  }
}

export async function removeScene(name) {
  await obs.call('RemoveScene', { sceneName: name });
}

export async function removeInput(name) {
  await obs.call('RemoveInput', { inputName: name });
}

export async function switchToProgram(sceneName) {
  await obs.call('SetCurrentProgramScene', { sceneName });
}

// Live preview: a JPEG screenshot of any source/scene as a data: URL.
export async function getSourceScreenshot(sourceName, { format = 'jpeg', quality = 70, width } = {}) {
  const params = { sourceName, imageFormat: format, compressionQuality: quality };
  if (width) params.imageWidth = Math.round(width);
  const { imageData } = await obs.call('GetSourceScreenshot', params);
  return imageData;
}

// --- background layer (browser source behind the slots) --------------------

// Ensure a full-canvas background browser source sits behind the slots.
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

// Best-effort removal of a layout's background browser input (called on delete).
export async function removeBackgroundInput(layoutName_) {
  const name = `Super Source • BG: ${layoutName_}`;
  try { await removeInput(name); } catch { /* absent */ }
}
