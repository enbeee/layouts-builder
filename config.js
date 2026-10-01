// Server-side configuration. Precedence: environment variables → credentials.md
// (optional, gitignored convenience file) → editor-only mode with no OBS connection.
// The OBS password is read here and NEVER sent to the browser or logged.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readCredentialsFile() {
  const file = path.join(__dirname, 'credentials.md');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  // Expected line: "OBS WebSocket: <host>:<port> - Password: <pw>"
  const m = raw.match(/OBS\s*WebSocket:\s*([^:\s]+):(\d+)\s*-\s*Password:\s*(\S+)/i);
  if (!m) {
    throw new Error('Could not parse credentials.md — expected "OBS WebSocket: <host>:<port> - Password: <pw>"');
  }
  return { host: m[1], port: Number(m[2]), password: m[3] };
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

const fileCreds = readCredentialsFile();

// OBS WebSocket — null when unconfigured: the editor still runs (no OBS sync).
export const obsHost = process.env.OBS_HOST || fileCreds?.host || null;
export const obsPort = process.env.OBS_PORT ? Number(process.env.OBS_PORT) : (fileCreds?.port ?? 4455);
export const obsPassword = process.env.OBS_PASSWORD || fileCreds?.password || null;
export const obsConfigured = !!(obsHost && obsPassword);
export const obsUrl = obsConfigured ? `ws://${obsHost}:${obsPort}` : null;

// Editor HTTP server
export const editorPort = process.env.PORT ? Number(process.env.PORT) : 8088;
export const bindAddress = process.env.BIND || '0.0.0.0';

// Access token for the editor WebSocket + /api routes. Set EDITOR_TOKEN to pin one,
// EDITOR_TOKEN='' to disable auth entirely (open LAN, old behavior), otherwise a
// random token is generated once and persisted to .editor-token (gitignored).
function resolveEditorToken() {
  if (process.env.EDITOR_TOKEN !== undefined) return process.env.EDITOR_TOKEN;
  const file = path.join(__dirname, '.editor-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* generate below */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}
export const editorToken = resolveEditorToken();
export const authEnabled = editorToken !== '';

// Base URL OBS uses to fetch background images from this server. OBS must be able
// to reach this host — override via OVERLAY_HOST if the auto-detected one is wrong
// (e.g. Docker/VPN interfaces).
export const overlayHost = process.env.OVERLAY_HOST || getLanIp();
export const overlayBaseUrl = `http://${overlayHost}:${editorPort}`;
