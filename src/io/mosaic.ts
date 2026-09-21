import type { Cell, ScanLayer } from "../layers/store";

/** Chrome's canvas limits: 32767 px per side, ~268M px total */
const MAX_SIDE = 32767;
const MAX_AREA = 268_000_000;

/** Tile scans left to right, top to bottom in `cols` columns; each column/row is as wide/tall as its biggest scan. */
export function layout(layers: ScanLayer[], cols: number): { cells: Cell[]; width: number; height: number } {
  cols = Math.max(1, Math.min(cols, layers.length));
  const rows = Math.ceil(layers.length / cols);
  const colW = new Array<number>(cols).fill(0);
  const rowH = new Array<number>(rows).fill(0);
  layers.forEach((l, i) => {
    colW[i % cols] = Math.max(colW[i % cols], l.width);
    rowH[(i / cols) | 0] = Math.max(rowH[(i / cols) | 0], l.height);
  });
  const xs = colW.map((_, i) => colW.slice(0, i).reduce((a, b) => a + b, 0));
  const ys = rowH.map((_, i) => rowH.slice(0, i).reduce((a, b) => a + b, 0));
  const cells = layers.map((l, i) => ({ id: l.id, x: xs[i % cols], y: ys[(i / cols) | 0], w: colW[i % cols], h: rowH[(i / cols) | 0] }));
  return { cells, width: colW.reduce((a, b) => a + b, 0), height: rowH.reduce((a, b) => a + b, 0) };
}

/** an error message if a canvas that size can't be made */
export function tooBig(width: number, height: number): string | null {
  return width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_AREA
    ? `mosaic would be ${width}×${height} px — too large for a browser canvas (max ${MAX_SIDE} px per side, ${MAX_AREA / 1e6}M px total)`
    : null;
}
