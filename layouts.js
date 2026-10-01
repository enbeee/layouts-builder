// Layout model + helpers. Box fields are normalized 0..1 over the canvas:
//   pos = [x, y] top-left corner, size = [w, h], crop = [left, right, top, bottom]
//   rotation = degrees clockwise around the box center
//   style  = per-box decoration (radius/border/shadow/opacity), see normalizeStyle.
import { SLOT_COUNT } from './obs.js';

export const LAYOUT_VERSION = 2;

// Strict slug: layout ids become filenames, so anything outside [a-z0-9-] is invalid.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function nameToId(name) {
  const id = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return isValidId(id) ? id : 'layout';
}

// --- per-box style ----------------------------------------------------------

export const DEFAULT_STYLE = Object.freeze({
  radius: 0,                                   // px on the final canvas
  border: { width: 0, color: '#ffffff', opacity: 1 },
  shadow: { blur: 0, spread: 0, offsetX: 0, offsetY: 0, color: '#000000', opacity: 0 },
  opacity: 1,
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, dflt, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
};
const hexColor = (v, dflt) => /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : dflt;

// Coerce an arbitrary style object into a complete, safe one. `defaults` is used
// for missing/invalid fields (layout-level defaults win over built-in ones).
export function normalizeStyle(raw, defaults) {
  const d = defaults || DEFAULT_STYLE;
  const src = raw && typeof raw === 'object' ? raw : {};
  const db = d.border || DEFAULT_STYLE.border;
  const ds = d.shadow || DEFAULT_STYLE.shadow;
  const b = src.border && typeof src.border === 'object' ? src.border : {};
  const s = src.shadow && typeof src.shadow === 'object' ? src.shadow : {};
  return {
    radius: num(src.radius, num(d.radius, 0, 0, 500), 0, 500),
    border: {
      width: num(b.width, num(db.width, 0, 0, 100), 0, 100),
      color: hexColor(b.color, hexColor(db.color, DEFAULT_STYLE.border.color)),
      opacity: num(b.opacity, num(db.opacity, 1, 0, 1), 0, 1),
    },
    shadow: {
      blur: num(s.blur, num(ds.blur, 0, 0, 200), 0, 200),
      spread: num(s.spread, num(ds.spread, 0, 0, 100), 0, 100),
      offsetX: num(s.offsetX, num(ds.offsetX, 0, -200, 200), -200, 200),
      offsetY: num(s.offsetY, num(ds.offsetY, 0, -200, 200), -200, 200),
      color: hexColor(s.color, hexColor(ds.color, DEFAULT_STYLE.shadow.color)),
      opacity: num(s.opacity, num(ds.opacity, 0.5, 0, 1), 0, 1),
    },
    opacity: num(src.opacity, num(d.opacity, 1, 0, 1), 0, 1),
  };
}

export function styleHasVisibleDecoration(style) {
  return style.radius > 0.5
    || style.border.width > 0.5
    || style.opacity < 0.999
    || style.shadow.opacity > 0.001;
}

// One-time migration from the v1 global `effects` block to per-box styles.
function migrateV1(layout) {
  const fx = layout.effects || {};
  const defaults = normalizeStyle({
    radius: fx.corner_radius,
    border: { width: fx.border_width },
    // v1 stored border color as a 0xAABBGGRR uint32; convert to #rrggbb.
    ...(fx.border_color !== undefined ? {
      border: {
        width: fx.border_width,
        color: '#' + [fx.border_color & 255, (fx.border_color >> 8) & 255, (fx.border_color >> 16) & 255]
          .map((v) => v.toString(16).padStart(2, '0')).join(''),
      },
    } : {}),
  });
  delete layout.effects;
  for (const b of layout.boxes || []) {
    if (!b.style) b.style = JSON.parse(JSON.stringify(defaults));
  }
  return defaults;
}

// Bring any layout object (from disk or from the network) up to the current schema.
export function normalizeLayout(data) {
  const layout = data && typeof data === 'object' ? data : {};
  if (layout.version !== LAYOUT_VERSION && Array.isArray(layout.boxes) && (layout.effects || layout.version === undefined)) {
    layout.version = LAYOUT_VERSION; // v1 → v2 migration marker (style fill happens below)
  } else {
    layout.version = LAYOUT_VERSION;
  }
  const defaults = layout.effects ? migrateV1(layout) : null;
  layout.name = String(layout.name || 'Layout').slice(0, 80);
  layout.id = isValidId(layout.id) ? layout.id : nameToId(layout.name);
  layout.boxes = normalizeBoxes(layout, defaults);
  layout.bg = layout.bg && layout.bg.src ? { src: String(layout.bg.src).slice(0, 500) } : null;
  // Stacking order, slot numbers bottom → top (index 0 in the OBS scene is the BG).
  const rawOrder = Array.isArray(layout.order) ? layout.order.map(Number) : [];
  layout.order = rawOrder.filter((s) => Number.isInteger(s) && s >= 1 && s <= SLOT_COUNT);
  for (const b of layout.boxes) if (!layout.order.includes(b.slot)) layout.order.push(b.slot);
  delete layout.effects;
  return layout;
}

// A fresh layout: four slot boxes in a neutral 2×2 starting arrangement, free to
// move/resize. (No built-in templates — you build your own.)
export function blankLayout(name = 'Layout') {
  const g = 0.012;
  const half = (1 - g) / 2;
  return normalizeLayout({
    name,
    boxes: [
      { slot: 1, enabled: true, pos: [0, 0], size: [half, half], crop: [0, 0, 0, 0] },
      { slot: 2, enabled: true, pos: [half + g, 0], size: [half, half], crop: [0, 0, 0, 0] },
      { slot: 3, enabled: true, pos: [0, half + g], size: [half, half], crop: [0, 0, 0, 0] },
      { slot: 4, enabled: true, pos: [half + g, half + g], size: [half, half], crop: [0, 0, 0, 0] },
    ],
    bg: null,
  });
}

// Ensure a layout has exactly SLOT_COUNT boxes in slot order. Boxes keep their own
// style; missing fields are filled from the layout defaults (or built-ins).
export function normalizeBoxes(layout, styleDefaults) {
  const raw = Array.isArray(layout.boxes) ? layout.boxes : [];
  const boxes = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const b = raw.find((x) => x && Number(x.slot) === i + 1) || raw[i] || {};
    boxes.push({
      slot: i + 1,
      enabled: b.enabled !== false,
      pos: [
        num(Array.isArray(b.pos) ? b.pos[0] : 0, 0, -0.95, 0.95),
        num(Array.isArray(b.pos) ? b.pos[1] : 0, 0, -0.95, 0.95),
      ],
      size: [
        num(Array.isArray(b.size) ? b.size[0] : 0.25, 0.25, 0.02, 1),
        num(Array.isArray(b.size) ? b.size[1] : 0.25, 0.25, 0.02, 1),
      ],
      crop: [
        num(Array.isArray(b.crop) ? b.crop[0] : 0, 0, 0, 0.95),
        num(Array.isArray(b.crop) ? b.crop[1] : 0, 0, 0, 0.95),
        num(Array.isArray(b.crop) ? b.crop[2] : 0, 0, 0, 0.95),
        num(Array.isArray(b.crop) ? b.crop[3] : 0, 0, 0, 0.95),
      ],
      rotation: num(b.rotation, 0, -180, 180),
      style: normalizeStyle(b.style, styleDefaults),
    });
  }
  layout.boxes = boxes;
  clampCrops(layout.boxes);
  return boxes;
}

// Keep crops from zeroing a box: opposing sides can't sum to 100% (cap 95% per axis).
export function clampCrops(boxes) {
  for (const b of boxes) {
    b.crop[0] = clamp(b.crop[0], 0, 0.95);
    b.crop[1] = clamp(b.crop[1], 0, 0.95 - b.crop[0]);
    b.crop[2] = clamp(b.crop[2], 0, 0.95);
    b.crop[3] = clamp(b.crop[3], 0, 0.95 - b.crop[2]);
  }
  return boxes;
}
