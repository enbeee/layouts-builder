// Persistence round-trip: newLayout -> setBox(with style) -> save -> open -> file + OBS readback.
// v2: dynamic canvas, current scene naming, per-box style persisted, no legacy keys.
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

  const lay = await rpc({ type: 'newLayout', name: 'Persist' }, 'layout');
  const ID = lay.layout.id;
  const NAME = lay.layout.name;
  const SC = `Super Source • Layout: ${NAME}`;

  await rpc({
    type: 'setBox', slot: 1,
    box: {
      slot: 1, enabled: true, pos: [0.1, 0.1], size: [0.5, 0.5], crop: [0, 0, 0, 0], rotation: 5,
      style: { radius: 30, border: { width: 4, color: '#ff8800', opacity: 1 }, shadow: { blur: 20, spread: 2, offsetX: 0, offsetY: 8, color: '#000000', opacity: 0.5 }, opacity: 1 },
    },
  }, 'box');
  const saved = await rpc({ type: 'save', name: 'Persist' }, 'saved');
  console.log('saved ids:', saved.saved.map((s) => s.id).join(','));

  const reopened = await rpc({ type: 'open', id: ID }, ['layout', 'error']);
  if (reopened.type === 'error') throw new Error(reopened.error);

  const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: SC, sourceName: 'Super Source • Slot 1' });
  const { sceneItemTransform: t } = await obs.call('GetSceneItemTransform', { sceneName: SC, sceneItemId });
  const expX = (0.1 + 0.5 / 2) * st.canvas.width; // center alignment -> box center
  console.log('reopened slot1 positionX:', t.positionX, '(exp', expX, ') rotation:', t.rotation);

  const j = JSON.parse(fs.readFileSync(`layouts/${ID}.json`, 'utf8'));
  const style = j.boxes?.[0]?.style;
  console.log('file version:', j.version, 'style.radius:', style?.radius, 'legacy effects key?', 'effects' in j, 'legacy decoration key?', 'decoration' in j);

  const ok = Math.abs(t.positionX - expX) < 1
    && t.rotation === 5
    && j.version === 2
    && style?.radius === 30
    && !('effects' in j)
    && !('decoration' in j)
    && fs.existsSync(`layouts/${ID}.json`);
  console.log(ok ? 'PASS ✅' : 'FAIL ❌');

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
