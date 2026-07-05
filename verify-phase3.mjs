// Core smoke: newLayout -> setBox -> OBS readback (Fit bounds, center alignment).
// Name-agnostic + self-cleaning (newLayout auto-saves, so we delete the file after).
import fs from 'node:fs';
import WebSocket from 'ws';
import { connect as obsConnect, getClient, removeScene } from './obs.js';

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 15000);
const ws = new WebSocket('ws://localhost:8088');
const send = (o) => ws.send(JSON.stringify(o));
const once = (f) => new Promise((res, rej) => {
  const h = (d) => { const m = JSON.parse(d.toString()); if (m.type === 'error') { ws.off('message', h); rej(new Error(m.error)); } else if (f(m)) { ws.off('message', h); res(m); } };
  ws.on('message', h);
});

ws.on('open', async () => {
  try {
    send({ type: 'hello' });
    const st = await once((m) => m.type === 'state');
    send({ type: 'newLayout', name: 'Smoke' });
    const lay = await once((m) => m.type === 'layout');
    const SC = `Super Source • Layout: ${lay.layout.name}`;
    const ID = lay.layout.id;
    console.log('layout:', lay.layout.name);

    send({ type: 'setBox', slot: 1, box: { slot: 1, enabled: true, pos: [0.05, 0.05], size: [0.4, 0.4], crop: [0.05, 0.05, 0.1, 0.1] } });
    await once((m) => m.type === 'box' && m.slot === 1);

    await obsConnect();
    const obs = getClient();
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
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
