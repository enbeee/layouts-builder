// Background layer test: upload -> set bg (source at index 0/back) -> clear (disabled).
// v2: uploads are re-encoded server-side (returned src is a .jpg), token-aware.
import fs from 'node:fs';
import path from 'node:path';
import { openEditorSocket, makeRpc, getToken, skip, ROOT } from './test/helpers.mjs';
import { connect as obsConnect, getClient, removeScene } from './obs.js';

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 20000);

const BASE = process.env.TEST_URL || 'http://localhost:8088';
const token = getToken();
const auth = token ? { Authorization: `Bearer ${token}` } : {};

let ws;
try { ws = await openEditorSocket(); } catch { skip('editor server not running (npm start first)'); }
const rpc = makeRpc(ws);

(async () => {
try {
  await rpc({ type: 'hello' }, 'state');
  let obs;
  try { obs = await obsConnect(); } catch { skip('OBS not reachable'); }

  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const up = await fetch(`${BASE}/api/bg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ name: 'bg-test.png', data: PNG_B64 }),
  });
  const { src, error } = await up.json();
  if (error) { console.error('upload failed:', error); process.exit(1); }
  const stored = decodeURIComponent(src.split('/').pop());
  console.log('uploaded bg src:', src, '| file exists:', fs.existsSync(path.join(ROOT, 'bgs', stored)));

  const lay = await rpc({ type: 'newLayout', name: 'BGTest' }, 'layout');
  const SC = `Super Source • Layout: ${lay.layout.name}`;
  const ID = lay.layout.id;
  const BG = `Super Source • BG: ${lay.layout.name}`;
  await rpc({ type: 'setBackground', src }, 'layout');

  const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: SC, sourceName: BG });
  const en = await obs.call('GetSceneItemEnabled', { sceneName: SC, sceneItemId });
  const idx = await obs.call('GetSceneItemIndex', { sceneName: SC, sceneItemId });
  console.log('bg itemId:', sceneItemId, '| enabled:', en.sceneItemEnabled, '| index:', idx.sceneItemIndex, '(0 = back)');

  await rpc({ type: 'setBackground', src: null }, 'layout');
  const en2 = await obs.call('GetSceneItemEnabled', { sceneName: SC, sceneItemId });
  console.log('bg enabled after clear:', en2.sceneItemEnabled);

  const ok = !!sceneItemId && en.sceneItemEnabled && idx.sceneItemIndex === 0 && !en2.sceneItemEnabled;
  console.log(ok ? 'PASS ✅' : 'FAIL ❌');

  try { await removeScene(SC); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(ROOT, 'layouts', `${ID}.json`)); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(ROOT, 'bgs', stored)); } catch { /* ignore */ }
  clearTimeout(timer);
  ws.close();
  process.exit(ok ? 0 : 1);
} catch (e) { console.error('ERR', e?.message || e); clearTimeout(timer); process.exit(1); }
})();
