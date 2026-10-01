// Effects pipeline v2: per-box style -> "Box Mask" (alpha) on the slot input,
// "Box Shadow" on the FX color source, NO chroma-key filter, and z-order applies.
import fs from 'node:fs';
import { openEditorSocket, makeRpc, skip } from './test/helpers.mjs';
import { connect as obsConnect, getClient, removeScene, slotName } from './obs.js';

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 25000);

let ws;
try { ws = await openEditorSocket(); } catch { skip('editor server not running (npm start first)'); }
const rpc = makeRpc(ws);

(async () => {
let obs;
try { obs = await obsConnect(); } catch { skip('OBS not reachable'); }
try {
  await rpc({ type: 'hello' }, 'state');
  const lay = await rpc({ type: 'newLayout', name: 'FxTest' }, 'layout');
  const SC = `Super Source • Layout: ${lay.layout.name}`;
  const ID = lay.layout.id;

  // Put a content source inside slot 1 (what a user would do with a camera).
  await obs.call('CreateInput', {
    sceneName: slotName(1), inputName: 'FxTest Source', inputKind: 'color_source_v3',
    inputSettings: { color: 0xff224488, width: 640, height: 360 }, sceneItemEnabled: true,
  });

  await rpc({
    type: 'setBox', slot: 1,
    box: {
      slot: 1, enabled: true, pos: [0.1, 0.1], size: [0.4, 0.4], crop: [0, 0, 0, 0],
      style: {
        radius: 40,
        border: { width: 4, color: '#ff0000', opacity: 1 },
        shadow: { blur: 30, spread: 2, offsetX: 0, offsetY: 12, color: '#000000', opacity: 0.6 },
        opacity: 1,
      },
    },
  }, 'box');

  let checks = [];
  // Mask filter with sane uniforms on the content source; no chroma key anywhere.
  const { filters } = await obs.call('GetSourceFilterList', { sourceName: 'FxTest Source' });
  const mask = filters.find((f) => f.filterName === 'Box Mask');
  const maskSet = mask ? await obs.call('GetSourceFilterSettings', { sourceName: 'FxTest Source', filterName: 'Box Mask' }) : null;
  checks.push(['Box Mask filter on slot input', !!mask]);
  checks.push(['mask is a shader filter', mask?.filterKind === 'shader_filter']);
  checks.push(['mask radius uniform set', maskSet ? Number(maskSet.filterSettings.radius_norm) > 0 : false]);
  checks.push(['no legacy Corner Key filter', !filters.some((f) => f.filterName === 'Corner Key')]);
  checks.push(['no legacy Box Effects filter', !filters.some((f) => f.filterName === 'Box Effects')]);

  // FX shadow source exists in the slot scene with the shadow filter.
  let fxOk = false, shadowOk = false;
  try {
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: slotName(1), sourceName: 'Super Source • FX 1' });
    fxOk = sceneItemId > 0;
    const sf = await obs.call('GetSourceFilterSettings', { sourceName: 'Super Source • FX 1', filterName: 'Box Shadow' });
    shadowOk = Number(sf.filterSettings.blur) === 30 && Number(sf.filterSettings.rect_l) >= 0;
  } catch { /* absent */ }
  checks.push(['FX shadow source in slot scene', fxOk]);
  checks.push(['Box Shadow uniforms (blur=30, rect set)', shadowOk]);

  // z-order: reorder, then read back the slot item index in the layout scene.
  await rpc({ type: 'reorder', order: [2, 1, 4, 3] }, 'layout');
  const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: SC, sourceName: 'Super Source • Slot 1' });
  const { sceneItemIndex } = await obs.call('GetSceneItemIndex', { sceneName: SC, sceneItemId });
  checks.push([`slot1 z-index after reorder = 2 (got ${sceneItemIndex})`, sceneItemIndex === 2]);

  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? '  ✓' : '  ✗'} ${label}`);
    ok = ok && pass;
  }
  console.log(ok ? 'PASS ✅' : 'FAIL ❌');

  // cleanup
  try { await obs.call('RemoveInput', { inputName: 'FxTest Source' }); } catch { /* ignore */ }
  try { await obs.call('RemoveInput', { inputName: 'Super Source • FX 1' }); } catch { /* ignore */ }
  try { await removeScene(SC); } catch { /* ignore */ }
  try { fs.unlinkSync(`layouts/${ID}.json`); } catch { /* ignore */ }
  clearTimeout(timer);
  ws.close();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('ERR', e?.message || e);
  clearTimeout(timer);
  process.exit(1);
}
})();
