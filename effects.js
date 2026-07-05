// Box effects on INPUT sources inside slot scenes. Creates filters with ALL settings
// (including shader_text) in the CreateSourceFilter call itself, so the plugin compiles
// the shader during creation — same as the UI path. No manual "reload" needed.
import { getClient, SLOT_COUNT, slotName } from './obs.js';

const FX_FILTER = 'Box Effects';
const KEY_FILTER = 'Corner Key';
const SKIP_KINDS = new Set(['text_gdiplus_v3', 'text_gdiplus', 'text_ft2_source', 'text_ft2', 'scene']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function applySourceEffects(layout, canvas, shaderText) {
  const effects = layout?.effects || {};
  const radius = Number(effects.corner_radius) || 0;
  const border = Number(effects.border_width) || 0;
  const color = Number(effects.border_color) || 0xFFFFFFFF;
  const enabled = radius > 0 || border > 0;
  const obs = getClient();

  for (let s = 1; s <= SLOT_COUNT; s++) {
    const scene = slotName(s);
    const box = (layout?.boxes || []).find((b) => b.slot === s);
    const crop = box?.crop || [0, 0, 0, 0];
    const boxOn = box?.enabled !== false;

    let items = [];
    try { const r = await obs.call('GetSceneItemList', { sceneName: scene }); items = r.sceneItems; } catch {}

    for (const item of items) {
      if (SKIP_KINDS.has(item.inputKind)) continue;
      const src = item.sourceName;

      // Always remove old filters first
      try { await obs.call('RemoveSourceFilter', { sourceName: src, filterName: FX_FILTER }); } catch {}
      try { await obs.call('RemoveSourceFilter', { sourceName: src, filterName: KEY_FILTER }); } catch {}

      if (enabled && boxOn) {
        // Shader filter: paints corners magenta + draws border
        await obs.call('CreateSourceFilter', {
          sourceName: src,
          filterName: FX_FILTER,
          filterKind: 'shader_filter',
          filterSettings: {
            override_entire_effect: false,
            from_file: false,
            shader_text: shaderText,
            corner_radius: radius,
            border_width: border,
            border_color: color,
            canvas_w: canvas.width,
            canvas_h: canvas.height,
            crop_left: crop[0] || 0,
            crop_right: crop[1] || 0,
            crop_top: crop[2] || 0,
            crop_bottom: crop[3] || 0,
          },
        });
        await sleep(200);
        // Color Key filter: keys out the magenta corners -> true transparency
        await obs.call('CreateSourceFilter', {
          sourceName: src,
          filterName: KEY_FILTER,
          filterKind: 'color_key_filter_v2',
          filterSettings: {
            key_color_type: 'magenta',
            similarity: 15,
            smoothness: 80,
            spill: 0,
          },
        });
        await sleep(100);
      }
    }
  }
}

export async function updateSlotCrop(layout, slot, canvas) {
  const scene = slotName(slot);
  const box = (layout?.boxes || []).find((b) => b.slot === slot);
  const crop = box?.crop || [0, 0, 0, 0];
  const obs = getClient();
  let items = [];
  try { const r = await obs.call('GetSceneItemList', { sceneName: scene }); items = r.sceneItems; } catch {}
  for (const item of items) {
    if (SKIP_KINDS.has(item.inputKind)) continue;
    try {
      const { filters } = await obs.call('GetSourceFilterList', { sourceName: item.sourceName });
      if (!filters.some((f) => f.filterName === FX_FILTER)) continue;
      await obs.call('SetSourceFilterSettings', { sourceName: item.sourceName, filterName: FX_FILTER, filterSettings: {
        crop_left: crop[0] || 0, crop_right: crop[1] || 0, crop_top: crop[2] || 0, crop_bottom: crop[3] || 0,
      }});
    } catch {}
  }
}

export async function cleanBoxEffects() {
  const obs = getClient();
  for (let s = 1; s <= SLOT_COUNT; s++) {
    let items = [];
    try { const r = await obs.call('GetSceneItemList', { sceneName: slotName(s) }); items = r.sceneItems; } catch {}
    for (const item of items) {
      try { await obs.call('RemoveSourceFilter', { sourceName: item.sourceName, filterName: FX_FILTER }); } catch {}
      try { await obs.call('RemoveSourceFilter', { sourceName: item.sourceName, filterName: KEY_FILTER }); } catch {}
    }
  }
}
