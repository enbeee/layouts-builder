// Box effects pipeline v2 — real alpha, no chroma key.
//
// Per slot:
//   • "Box Mask" (boxfx_mask.shader) on every video input inside the slot scene:
//     rounded corners + border + box opacity via alpha output.
//   • "Super Source • FX <n>" — a canvas-sized transparent color source at the
//     BOTTOM of the slot scene carrying "Box Shadow" (boxfx_shadow.shader): a soft
//     drop shadow that can spill beyond the box, because the slot scene has the
//     whole canvas to draw on. Overlapping boxes composite correctly via alpha and
//     slot-item order — the thing the old magenta-key pipeline could never do.
//
// All pixel uniforms are computed server-side in final-screen px and converted:
//   • mask  → normalized by content-screen width (aspect-proof circular corners)
//   • shadow → divided by the SCALE_INNER fit factor into slot-canvas px
import { getClient, SLOT_COUNT, slotName, findSceneItemId } from './obs.js';

const MASK_FILTER = 'Box Mask';
const SHADOW_FILTER = 'Box Shadow';
const fxInputName = (slot) => `Super Source • FX ${slot}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Filters created here compile the shader inline (from_file: false + shader_text in
// the CreateSourceFilter call), matching the UI path so the plugin compiles once.
const CREATE_SLEEP = 150;

function skipForMask(item) {
  if (item.sourceType === 'OBS_SOURCE_TYPE_SCENE' || item.sourceType === 'OBS_SOURCE_TYPE_TRANSITION') return true;
  const kind = String(item.inputKind || '');
  return kind.startsWith('color_source'); // our own FX sources
}

// '#rrggbb' + opacity → 0xAABBGGRR uint32, the packed form obs-shaderfilter uses
// for float4 color uniforms.
function packColor(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// Geometry shared by both shaders. The visible content rect is the crop rect of the
// slot canvas; SCALE_INNER fits it into the box, so screen px = canvas px * fit.
function fxGeom(layout, slot, canvas) {
  const box = (layout?.boxes || []).find((b) => b.slot === slot);
  const crop = box?.crop || [0, 0, 0, 0];
  const style = box?.style;
  const W = canvas.width, H = canvas.height;
  const cw = Math.max(1 - crop[0] - crop[1], 0.05);
  const ch = Math.max(1 - crop[2] - crop[3], 0.05);
  const contentW = cw * W, contentH = ch * H;
  const fit = Math.min((box.size[0] * W) / contentW, (box.size[1] * H) / contentH);
  const contentScreenW = contentW * fit;
  return { box, crop, style, W, H, fit, contentW, contentH, contentScreenW };
}

// Content screen height / width — normalizes the mask SDF so 1 unit = content
// width on both axes and corners render as perfect circles on screen.
function contentAspect(crop, W, H) {
  const cw = Math.max(1 - crop[0] - crop[1], 0.05);
  const ch = Math.max(1 - crop[2] - crop[3], 0.05);
  return (ch * H) / (cw * W);
}

async function listSlotItems(scene) {
  const obs = getClient();
  try {
    const r = await obs.call('GetSceneItemList', { sceneName: scene });
    return r.sceneItems;
  } catch {
    return [];
  }
}

async function listFilters(sourceName) {
  const obs = getClient();
  try {
    const r = await obs.call('GetSourceFilterList', { sourceName });
    return r.filters;
  } catch {
    return [];
  }
}

// Ensure the shadow-carrying FX color source exists at the bottom of the slot scene.
async function ensureFxInput(scene, slot, canvas) {
  const obs = getClient();
  const name = fxInputName(slot);
  const settings = { color: 0, width: Number(canvas.width), height: Number(canvas.height) };
  let itemId = await findSceneItemId(scene, name);
  if (!itemId) {
    let exists = false;
    try { await obs.call('GetInputSettings', { inputName: name }); exists = true; } catch { /* none */ }
    if (exists) {
      try { await obs.call('SetInputSettings', { inputName: name, inputSettings: settings, overlay: true }); } catch { /* keep old */ }
      itemId = (await obs.call('CreateSceneItem', { sceneName: scene, sourceName: name, sceneItemEnabled: true })).sceneItemId;
    } else {
      itemId = (await obs.call('CreateInput', {
        sceneName: scene, inputName: name, inputKind: 'color_source_v3',
        inputSettings: settings, sceneItemEnabled: true,
      })).sceneItemId;
    }
  }
  await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: itemId, sceneItemEnabled: true });
  try { await obs.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: itemId, sceneItemIndex: 0 }); } catch { /* ignore */ }
  return itemId;
}

async function ensureMaskFilter(sourceName, uniforms, shaderText) {
  const obs = getClient();
  const filters = await listFilters(sourceName);
  if (filters.some((f) => f.filterName === MASK_FILTER)) {
    await obs.call('SetSourceFilterSettings', { sourceName, filterName: MASK_FILTER, filterSettings: uniforms });
    return;
  }
  await obs.call('CreateSourceFilter', {
    sourceName, filterName: MASK_FILTER, filterKind: 'shader_filter',
    filterSettings: { override_entire_effect: false, from_file: false, shader_text: shaderText, ...uniforms },
  });
  await sleep(CREATE_SLEEP);
}

async function ensureShadowFilter(sourceName, uniforms, shaderText) {
  const obs = getClient();
  const filters = await listFilters(sourceName);
  if (filters.some((f) => f.filterName === SHADOW_FILTER)) {
    await obs.call('SetSourceFilterSettings', { sourceName, filterName: SHADOW_FILTER, filterSettings: uniforms });
    return;
  }
  await obs.call('CreateSourceFilter', {
    sourceName, filterName: SHADOW_FILTER, filterKind: 'shader_filter',
    filterSettings: { override_entire_effect: false, from_file: false, shader_text: shaderText, ...uniforms },
  });
  await sleep(CREATE_SLEEP);
}

// Create/update/remove both effects for one slot so OBS matches the layout exactly.
export async function syncSlotEffects(layout, slot, canvas, maskShader, shadowShader) {
  const obs = getClient();
  const scene = slotName(slot);
  const { box, crop, style, W, H, fit, contentScreenW } = fxGeom(layout, slot, canvas);
  const s = style || { radius: 0, border: { width: 0, opacity: 1 }, shadow: { opacity: 0 }, opacity: 1 };
  const maskNeeded = box?.enabled !== false && (s.radius > 0.5 || s.border.width > 0.5 || s.opacity < 0.999);
  const shadowNeeded = box?.enabled !== false && s.shadow.opacity > 0.001;

  const aa = 2 / contentScreenW;
  const maskUniforms = {
    crop_left: crop[0], crop_right: crop[1], crop_top: crop[2], crop_bottom: crop[3],
    radius_norm: s.radius / fit / contentScreenW,
    border_norm: s.border.width / fit / contentScreenW,
    aa_norm: aa,
    norm_h: contentAspect(crop, W, H),
    border_color: packColor(s.border.color, s.border.opacity),
    opacity: s.opacity,
  };
  const shadowUniforms = {
    canvas_w: W, canvas_h: H,
    rect_l: crop[0] * W, rect_t: crop[2] * H, rect_r: (1 - crop[1]) * W, rect_b: (1 - crop[3]) * H,
    radius: s.radius / fit,
    blur: s.shadow.blur / fit,
    spread: s.shadow.spread / fit,
    offset_x: s.shadow.offsetX / fit,
    offset_y: s.shadow.offsetY / fit,
    shadow_color: packColor(s.shadow.color, s.shadow.opacity),
  };

  for (const item of await listSlotItems(scene)) {
    if (skipForMask(item)) continue;
    const src = item.sourceName;
    if (maskNeeded) {
      await ensureMaskFilter(src, maskUniforms, maskShader);
    } else {
      try { await obs.call('RemoveSourceFilter', { sourceName: src, filterName: MASK_FILTER }); } catch { /* gone */ }
    }
  }

  const fxName = fxInputName(slot);
  if (shadowNeeded) {
    await ensureFxInput(scene, slot, canvas);
    await ensureShadowFilter(fxName, shadowUniforms, shadowShader);
  } else {
    try { await obs.call('RemoveSourceFilter', { sourceName: fxName, filterName: SHADOW_FILTER }); } catch { /* gone */ }
    const itemId = await findSceneItemId(scene, fxName);
    if (itemId) {
      try { await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: itemId, sceneItemEnabled: false }); } catch { /* ignore */ }
    }
  }
}

// Sync every slot (used on layout open / reconnect / template apply).
export async function applySlotEffects(layout, canvas, maskShader, shadowShader) {
  for (let s = 1; s <= SLOT_COUNT; s++) {
    await syncSlotEffects(layout, s, canvas, maskShader, shadowShader);
  }
}

// Fast path while dragging: only refresh uniforms for filters that already exist.
export async function updateSlotEffects(layout, slot, canvas, maskShader, shadowShader) {
  await syncSlotEffects(layout, slot, canvas, maskShader, shadowShader);
}

// Startup hygiene: strip every filter this app (any version) ever created.
export async function cleanBoxEffects() {
  const obs = getClient();
  const names = ['Box Effects', 'Corner Key', MASK_FILTER, SHADOW_FILTER];
  let inputs = [];
  try { ({ inputs } = await obs.call('GetInputList')); } catch { /* ignore */ }
  for (const input of inputs) {
    for (const n of names) {
      try { await obs.call('RemoveSourceFilter', { sourceName: input.inputName, filterName: n }); } catch { /* absent */ }
    }
  }
  let scenes = [];
  try { ({ scenes } = await obs.call('GetSceneList')); } catch { /* ignore */ }
  for (const sc of scenes) {
    for (const n of names) {
      try { await obs.call('RemoveSourceFilter', { sourceName: sc.sceneName, filterName: n }); } catch { /* absent */ }
    }
  }
}
