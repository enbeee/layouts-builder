// Layout model + helpers. Box fields are normalized 0..1 over the canvas:
//   pos = [x, y] top-left corner, size = [w, h], crop = [left, right, top, bottom]
import { SLOT_COUNT } from './obs.js';

export function nameToId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'layout';
}

// A fresh layout: four slot boxes in a neutral 2×2 starting arrangement, free to
// move/resize. (No built-in templates — you build your own.)
export function blankLayout(name = 'Layout') {
  const g = 0.012;
  const half = (1 - g) / 2;
  return {
    id: nameToId(name),
    name,
    boxes: [
      { slot: 1, enabled: true, pos: [0, 0], size: [half, half], crop: [0, 0, 0, 0] },
      { slot: 2, enabled: true, pos: [half + g, 0], size: [half, half], crop: [0, 0, 0, 0] },
      { slot: 3, enabled: true, pos: [0, half + g], size: [half, half], crop: [0, 0, 0, 0] },
      { slot: 4, enabled: true, pos: [half + g, half + g], size: [half, half], crop: [0, 0, 0, 0] },
    ],
    bg: null,
  };
}

// Ensure a layout object has exactly SLOT_COUNT boxes (pad disabled if needed).
export function normalizeBoxes(layout) {
  const boxes = layout.boxes.slice(0, SLOT_COUNT);
  while (boxes.length < SLOT_COUNT) {
    boxes.push({ slot: boxes.length + 1, enabled: false, pos: [0, 0], size: [0.25, 0.25], crop: [0, 0, 0, 0] });
  }
  boxes.forEach((b, i) => { b.slot = i + 1; });
  return boxes;
}

// Keep crop from zeroing a box: opposing sides can't sum to 100% (cap 95% per axis).
export function clampCrop(b) {
  b.crop = b.crop || [0, 0, 0, 0];
  b.crop[0] = Math.max(0, Math.min(b.crop[0], 0.95));
  b.crop[1] = Math.max(0, Math.min(b.crop[1], 0.95 - b.crop[0]));
  b.crop[2] = Math.max(0, Math.min(b.crop[2], 0.95));
  b.crop[3] = Math.max(0, Math.min(b.crop[3], 0.95 - b.crop[2]));
  return b;
}
