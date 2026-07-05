!!! Another stupid vibe coding experiment -- use at your own risk !!!

# Super Source Layout Builder for OBS

A web-based, H2R-Layouts-style "SuperSource" layout builder that drives **OBS Studio**
live over its WebSocket API. You design multi-box layouts in a browser; each box maps to
one of four fixed **slot scenes** whose content you arrange in OBS. Layouts are saved as
real OBS scenes and can be switched to air from the app or from Bitfocus Companion.

## Run
```bash
npm install
npm start          # node server.js
```
Open **http://localhost:8088**. OBS WebSocket connection details are read from
`credentials.md` (format: `OBS WebSocket: <host>:<port> - Password: <pw>`).

The server only needs to reach OBS WebSocket — on this LAN it can (`10.0.0.17:4455`).

## First-time setup in OBS
The app creates four **`Super Source • Slot 1 … Slot 4`** scenes on connect. Open each in OBS and
put whatever a box should show there (a camera, a camera + lower-third, an image, a
browser source…). That content is the "variable" part; layouts just position the slots.

## Using the editor
- **New** → creates a fresh layout with four slot boxes in a neutral 2×2; drag/resize
  them to build your own. (No built-in templates.)
- **Drag** boxes to move, **drag the corner handle** to resize (hold **Shift** to keep
  aspect ratio). Arrow keys nudge (Shift = 10×). Snapping to center/edge guides; set the
  distance in px under **Snap** (0 disables).
- Sidebar: per-box **Position / Size / Crop** (in pixels), **Enabled**, **Copy/Paste**.
- **Save / Open / Delete** layouts (stored as `layouts/<id>.json`).

## Switching during a show
- In the app: **Take** sends the current layout to OBS Program; the **Switch** box has a
  button per saved layout to take it straight to Program.
- In Companion: one button per layout scene.

## How it maps onto OBS
- A box `{pos, size, crop}` (normalized 0–1) → scene-item transform with
  `boundsType = OBS_BOUNDS_STRETCH`, `boundsWidth/Height`, top-left `alignment`, and
  per-side crop in canvas pixels.
- Each layout = a scene (`Super Source • Layout: <Name>`) containing the four slot scenes as items.

## Files
- `server.js` — HTTP + WebSocket bridge, persistence, OBS sync.
- `obs.js` — all OBS WebSocket calls (slots, layouts, transforms, switching).
- `layouts.js` — layout model and helpers (boxes, crop guard).
- `config.js` — parses `credentials.md`.
- `public/` — the editor UI (`index.html`, `editor.js`, `editor.css`).
- `verify-phase3.mjs` — smoke test (drives the WS API + reads OBS back).

## Notes / limitations
- Crop uses canvas-pixel space (slot scenes are canvas-sized) and is guarded so opposing
  sides can't sum to 100% (a box can't be cropped to nothing).
