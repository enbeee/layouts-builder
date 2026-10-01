// Core smoke: newLayout -> setBox -> OBS readback (Fit bounds, center alignment).
// Name-agnostic + self-cleaning (newLayout auto-saves, so we delete the file after).
import fs from 'node:fs';
import { openEditorSocket, makeRpc, skip } from './test/helpers.mjs';
import { connect as obsConnect, getClient, removeScene } from './obs.js';

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 20000);

let ws;
try { ws = await openEditorSocket(); } catch { skip('editor server not running (npm start first)'); }
const rpc = makeRpc(ws);

(async () => {
try {
  const st = await rpc({ type: 'hello' }, 'state');
  let obs;
  try { obs = await obsConnect(); } catch { skip('OBS not reachable'); }
  console.log('layout:', 'creating…');

  const lay = await rpc({ type: 'newLayout', name: 'Smoke' }, 'layout');
  const SC = `Super Source • Layout: ${lay.layout.name}`;
  const ID = lay.layout.id;

  await rpc({ type: 'setBox', slot: 1, box: { slot: 1, enabled: true, pos: [0.05, 0.05], size: [0.4, 0.4], crop: [0.05, 0.05, 0.1, 0.1] } }, 'box');

  const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: SC, sourceName: 'Super Source • Slot 1' });
  const { sceneItemTransform: t } = await obs.call('GetSceneItemTransform', { sceneName: SC, sceneItemId });
  const expX = (0.05 + 0.4 / 2) * st.canvas.width; // center alignment -> box center
  const expW = 0.4 * st.canvas.width;
  console.log(`slot1 positionX=${t.positionX} (exp ${expX})  boundsWidth=${t.boundsWidth} (exp ${expW})  boundsType=${t.boundsType}`);
  const ok = Math.abs(t.positionX - expX) < 1 && Math.abs(t.boundsWidth - expW) < 1 && t.boundsType === 'OBS_BOUNDS_SCALE_INNER';
  console.log(ok ? 'PASS ✅' : 'FAIL ❌');

  try { await removeScene(SC); } catch { /* ignore */ }
  try { fs.unlinkSync(`layouts/${ID}.json`); } catch { /* ignore */ }
  clearTimeout(timer);
  ws.close();
  process.exit(ok ? 0 : 1);
} catch (e) { console.error('smoke test error:', e?.message || e); clearTimeout(timer); process.exit(1); }
})();
