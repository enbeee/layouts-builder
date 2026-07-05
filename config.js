// Server-side configuration. Parses OBS WebSocket credentials from credentials.md.
// The password is read here and NEVER sent to the browser or logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readCredentials() {
  const file = path.join(__dirname, 'credentials.md');
  const raw = fs.readFileSync(file, 'utf8');
  // Expected line: "OBS WebSocket: 10.0.0.10:4455 - Password: 12345"
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

const creds = readCredentials();

// OBS WebSocket
export const obsHost = process.env.OBS_HOST || creds.host;
export const obsPort = process.env.OBS_PORT ? Number(process.env.OBS_PORT) : creds.port;
export const obsPassword = process.env.OBS_PASSWORD || creds.password;
export const obsUrl = `ws://${obsHost}:${obsPort}`;

// Editor HTTP server
export const editorPort = process.env.PORT ? Number(process.env.PORT) : 8088;

// Base URL OBS uses to fetch the decoration overlay from this server.
// OBS (10.0.0.17) must be able to reach this host — override via OVERLAY_HOST if needed.
export const overlayHost = process.env.OVERLAY_HOST || getLanIp();
export const overlayBaseUrl = `http://${overlayHost}:${editorPort}`;
