# Super Source Layout Builder for OBS

A web-based, H2R-Layouts-style "SuperSource" layout builder that drives **OBS Studio**
live over its WebSocket API. You design multi-box layouts in a browser; each box maps to
one of the **slot scenes** whose content you arrange in OBS. Layouts are saved as real
OBS scenes and can be switched to air from the app or from Bitfocus Companion.

Born from a vibe-coding experiment, now with real alpha-composited box styling —
rounded corners, borders and **soft drop shadows that survive overlapping boxes**.

## Run
```bash
npm install
npm start          # node server.js
```
Open the quick-open URL printed on startup (it embeds the access token), or
`http://localhost:8088` and paste the token when prompted.

**Configuration** (env vars win, `credentials.md` is an optional convenience file):

| Setting         | Env var                          | Fallback                              |
|-----------------|----------------------------------|---------------------------------------|
| OBS WebSocket   | `OBS_HOST` / `OBS_PORT` / `OBS_PASSWORD` | `credentials.md` (gitignored) |
| Editor port     | `PORT`                           | `8088`                                |
| Bind address    | `BIND`                           | `0.0.0.0`                             |
| Access token    | `EDITOR_TOKEN` (`''` = disable)  | auto-generated → `.editor-token`      |
| Overlay host    | `OVERLAY_HOST`                   | auto-detected LAN IP                  |
| Slot count      | `SLOT_COUNT`                     | `4`                                   |

Copy `credentials.example.md` to `credentials.md` and fill it in, or set the env vars.
With **no OBS credentials the server still runs** (editor-only mode): layouts save and
preview locally and sync to OBS on a later start.

> **Security:** the editor WebSocket and `/api` routes require the access token; anyone
> on the network can otherwise control live OBS. `/bg` images stay open for OBS itself.
> Set `EDITOR_TOKEN=''` only on a trusted LAN. The token lives in `.editor-token`
> (gitignored) or your environment — never commit it.

## First-time setup in OBS
- Install the [obs-shaderfilter](https://obsproject.com/forum/resources/obs-shaderfilter.1736/) plugin
  (box corners/borders/shadows are applied through it).
- The app creates **`Super Source • Slot 1 … Slot N`** scenes on connect. Open each in
  OBS and put whatever a box should show there (a camera, a camera + lower-third, an
  image, a browser source…). That content is the "variable" part; layouts just position
  the slots.
- Bitfocus Companion users: the scene names are stable, one button per layout scene.

## Using the editor
- **New / Save / Duplicate / Delete / Export / Import** layouts (JSON files in `layouts/`).
- **Templates**: 2×2 grid, big frame + PiP stack, thirds, focus + bottom strip, corner PiPs.
- **Drag** boxes to move; resize from any of the **8 handles** (hold **Shift** for aspect
  lock); drag the yellow lines to **crop**; sidebar gives per-box position/size/crop in
  px plus **rotation**.
- **Layers panel** sets z-order live in OBS (top of list is in front); align/distribute
  buttons tidy multi-box layouts.
- **Style (per box)**: corner radius, border (width/color/opacity), **drop shadow**
  (blur/spread/offset/color/opacity), box opacity — rendered in the browser preview and
  applied in OBS through alpha-output shaders.
- **OBS preview**: fetches a live screenshot of the layout scene from OBS as the canvas
  backdrop (manual or every 2.5 s) — true WYSIWYG.
- **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z), arrow-key nudge (Shift = 10×), Delete toggles a
  box, snapping to canvas edges/center and other boxes' edges/centers (distance under
  **Snap**, 0 disables).
- **Take** sends the current layout to OBS Program; the **Switch** panel has a button per
  saved layout.

## How it maps onto OBS
- Each layout is a scene (`Super Source • Layout: <Name>`) containing the slot scenes as
  items, plus an optional full-canvas background browser source at the bottom.
- A box `{pos, size, crop, rotation, style}` (pos/size/crop normalized 0–1) → scene-item
  transform with `boundsType = OBS_BOUNDS_SCALE_INNER` (aspect-preserving fit), center
  alignment, per-side crop and rotation.
- **Box styling pipeline** (per slot):
  - `Box Mask` (`shaders/boxfx_mask.shader`) on the slot's video inputs: anti-aliased
    rounded corners + border + box opacity via **real alpha output**.
  - `Super Source • FX <n>` — a canvas-sized transparent color source under the video —
    carries `Box Shadow` (`shaders/boxfx_shadow.shader`): a soft drop shadow that can
    spill beyond the box. Because each slot scene is canvas-sized, shadows overlap
    correctly by scene-item order (the old magenta chroma-key trick could do neither).
- Crop uses canvas-pixel space (slot scenes are canvas-sized) and is guarded so opposing
  sides can't sum to 100% (a box can't be cropped to nothing).

## Files
- `server.js` — HTTP + WebSocket bridge, token auth, persistence, OBS sync.
- `obs.js` — all OBS WebSocket calls (serialized through a promise queue).
- `effects.js` — per-box shader-filter pipeline (mask + shadow).
- `layouts.js` — layout model, per-box styles, validation, v1→v2 migration.
- `config.js` — env/`credentials.md` parsing, token generation.
- `shaders/` — the two obs-shaderfilter shaders.
- `public/` — the editor UI (`index.html`, `editor.js`, `editor.css`).
- `verify-*.mjs` + `test/` — integration tests (see below).

## Tests
With the server running (`npm start`) and, for the OBS-backed tests, OBS reachable:
```bash
npm test
```
Tests missing prerequisites (server down, OBS unreachable) SKIP cleanly, so the suite is
safe on any machine. `verify-persist.mjs` covers persistence (v2 schema), `verify-bg.mjs`
the background layer, `verify-effects.mjs` the shader pipeline and z-order, and
`verify-phase3.mjs` the box-transform math.

## systemd
See `layouts-builder.service` — copy it to `/etc/systemd/system/`, check the `EnvironmentFile`
path (put credentials/tokens in `/etc/default/layouts-builder`, mode 600), then
`systemctl daemon-reload && systemctl enable --now layouts-builder`.
