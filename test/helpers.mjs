// Shared helpers for the verify-* integration scripts.
// They drive a RUNNING server over WebSocket (and OBS itself where noted), so
// start the server first (`npm start`). Scripts SKIP (exit 0) when their
// prerequisites are missing so `npm test` is usable without OBS attached.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

export function getToken() {
  if (process.env.EDITOR_TOKEN) return process.env.EDITOR_TOKEN;
  try { return fs.readFileSync(path.join(ROOT, '.editor-token'), 'utf8').trim(); } catch { return ''; }
}

// Connect to the editor WS. Throws with .unreachable = true when the server is down.
export async function openEditorSocket() {
  const base = process.env.TEST_URL || 'ws://localhost:8088';
  const token = getToken();
  const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', (e) => { e.unreachable = true; rej(e); });
  });
  return ws;
}

// Strict type-matched request/reply helper. A settle window before each request
// lets straggler broadcasts from the previous one (e.g. newLayout's async 'saved')
// land first, so they can't be mistaken for the reply.
export function makeRpc(ws) {
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const wi = waiters.findIndex((w) => w.types.includes(m.type));
    if (wi >= 0) { const [w] = waiters.splice(wi, 1); w.resolve(m); } else inbox.push(m);
  });
  const waitFor = (types, ms = 8000) => new Promise((res, rej) => {
    const i = inbox.findIndex((m) => types.includes(m.type));
    if (i >= 0) return res(inbox.splice(i, 1)[0]);
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${types}`)), ms);
    waiters.push({ types, resolve: (m) => { clearTimeout(t); res(m); } });
  });
  const rpc = async (o, types) => {
    await new Promise((r) => setTimeout(r, 120));
    inbox.length = 0;
    ws.send(JSON.stringify(o));
    return waitFor(Array.isArray(types) ? types : [types]);
  };
  return rpc;
}

export function skip(reason) {
  console.log(`SKIP — ${reason}`);
  process.exit(0);
}
