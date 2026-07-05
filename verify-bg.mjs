// Background layer test: upload -> set bg (source at index 0/back) -> clear (removed).
import fs from 'node:fs';
import WebSocket from 'ws';
import { connect as obsConnect, getClient, removeScene } from './obs.js';

const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 20000);

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const up = await fetch('http://localhost:8088/api/bg', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'bg-test.png', data: PNG_B64 }),
});
const { src } = await up.json();
console.log('uploaded bg src:', src, '| file exists:', fs.existsSync('bgs/bg-test.png'));

const ws = new WebSocket('ws://localhost:8088');
const send = (o) => ws.send(JSON.stringify(o));
const once = (f) => new Promise((res, rej) => {
  const h = (d) => { const m = JSON.parse(d.toString()); if (m.type === 'error') { ws.off('message', h); rej(new Error(m.error)); } else if (f(m)) { ws.off('message', h); res(m); } };
  ws.on('message', h);
});

ws.on('open', async () => {
  try {
    send({ type: 'hello' }); await once((m) => m.type === 'state');
    send({ type: 'newLayout', name: 'BGTest' });
    const lay = await once((m) => m.type === 'layout');
    const SC = `Super Source • Layout: ${lay.layout.name}`;
    const ID = lay.layout.id;
    const BG = `Super Source • BG: ${lay.layout.name}`;
    send({ type: 'setBackground', src }); await once((m) => m.type === 'layout');

    await obsConnect();
    const obs = getClient();
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: SC, sourceName: BG });
    const en = await obs.call('GetSceneItemEnabled', { sceneName: SC, sceneItemId });
    const idx = await obs.call('GetSceneItemIndex', { sceneName: SC, sceneItemId });
    console.log('bg itemId:', sceneItemId, '| enabled:', en.sceneItemEnabled, '| index:', idx.sceneItemIndex, '(0 = back)');

    send({ type: 'setBackground', src: null }); await once((m) => m.type === 'layout');
    const en2 = await obs.call('GetSceneItemEnabled', { sceneName: SC, sceneItemId });
    console.log('bg enabled after clear:', en2.sceneItemEnabled);

    const ok = !!sceneItemId && en.sceneItemEnabled && idx.sceneItemIndex === 0 && !en2.sceneItemEnabled;
    console.log(ok ? 'PASS ✅' : 'FAIL ❌');

    try { await removeScene(SC); } catch { /* ignore */ }
    try { fs.unlinkSync(`layouts/${ID}.json`); } catch { /* ignore */ }
    try { fs.unlinkSync('bgs/bg-test.png'); } catch { /* ignore */ }
    clearTimeout(timer);
    ws.close();
    process.exit(ok ? 0 : 1);
  } catch (e) { console.error('ERR', e?.message || e); clearTimeout(timer); process.exit(1); }
});
ws.on('error', (e) => { console.error('ws err', e.message); process.exit(1); });
