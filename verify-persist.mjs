// Persistence round-trip: newLayout -> setBox -> save -> open -> OBS readback.
// Also confirms saved files no longer carry a decoration field.
import fs from 'node:fs';
import WebSocket from 'ws';
import { connect as obsConnect, getClient, removeScene } from './obs.js';

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 15000);
const ws = new WebSocket('ws://localhost:8088');
const send = (o) => ws.send(JSON.stringify(o));
const once = (f) => new Promise((res, rej) => {
  const h = (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'error') { ws.off('message', h); rej(new Error(m.error)); }
    else if (f(m)) { ws.off('message', h); res(m); }
  };
  ws.on('message', h);
});

ws.on('open', async () => {
  try {
    send({ type: 'hello' });
    await once((m) => m.type === 'state');
    send({ type: 'newLayout', name: 'Persist' });
    await once((m) => m.type === 'layout');
    send({ type: 'setBox', slot: 1, box: { slot: 1, enabled: true, pos: [0.1, 0.1], size: [0.5, 0.5], crop: [0, 0, 0, 0] } });
    await once((m) => m.type === 'box' && m.slot === 1);
    send({ type: 'save', name: 'Persist' });
    const saved = await once((m) => m.type === 'saved');
    console.log('saved ids:', saved.saved.map((s) => s.id).join(','));

    send({ type: 'open', id: 'persist' });
    await once((m) => m.type === 'layout');

    await obsConnect();
    const obs = getClient();
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: 'SS • Layout: Persist', sourceName: 'SS • Slot 1' });
    const { sceneItemTransform: t } = await obs.call('GetSceneItemTransform', { sceneName: 'SS • Layout: Persist', sceneItemId });
    const expX = 0.1 * 1920;
    console.log('reopened slot1 positionX:', t.positionX, '(exp', expX, ')');

    const j = JSON.parse(fs.readFileSync('layouts/persist.json', 'utf8'));
    console.log('saved file has decoration key?', 'decoration' in j);

    const ok = Math.abs(t.positionX - expX) < 1 && fs.existsSync('layouts/persist.json') && !('decoration' in j);
    console.log(ok ? 'PASS ✅' : 'FAIL ❌');

    try { await removeScene('SS • Layout: Persist'); } catch { /* ignore */ }
    try { fs.unlinkSync('layouts/persist.json'); } catch { /* ignore */ }
    clearTimeout(timer);
    ws.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('ERR', e?.message || e);
    clearTimeout(timer);
    process.exit(1);
  }
});
ws.on('error', (e) => { console.error('ws err', e.message); process.exit(1); });
