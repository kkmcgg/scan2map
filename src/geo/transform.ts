import { MIN_GCPS, completeGcps, type Group, type Method, type ScanLayer } from "../layers/store";

export type Order = 1 | 2 | 3;

/** GDAL-style: x = a + b*col + c*row, y = d + e*col + f*row */
export type GeoTransform = [number, number, number, number, number, number];

export interface Fit {
  order: Order;
  n: number; // points used
  rmse: number; // in CRS units
  residuals: { id: string; err: number }[];
  geo: GeoTransform | null; // affine only
  /** map units per pixel along columns and rows, and rotation of the column axis in degrees (measured at the centre) */
  pixelSize: [number, number];
  rotation: number;
  at(col: number, row: number): [number, number];
}

const NTERMS: Record<Order, number> = { 1: 3, 2: 6, 3: 10 };

function terms(order: Order, u: number, v: number): number[] {
  const t = [1, u, v];
  if (order >= 2) t.push(u * u, u * v, v * v);
  if (order >= 3) t.push(u * u * u, u * u * v, u * v * v, v * v * v);
  return t;
}

/** solve the square system M c = r in place (partial pivoting); null if singular */
function solve(M: number[][], r: number[]): number[] | null {
  const n = r.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
    if (Math.abs(M[p][i]) < 1e-10) return null;
    [M[i], M[p]] = [M[p], M[i]];
    [r[i], r[p]] = [r[p], r[i]];
    for (let j = i + 1; j < n; j++) {
      const f = M[j][i] / M[i][i];
      for (let k = i; k < n; k++) M[j][k] -= f * M[i][k];
      r[j] -= f * r[i];
    }
  }
  const c = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = r[i];
    for (let k = i + 1; k < n; k++) s -= M[i][k] * c[k];
    c[i] = s / M[i][i];
  }
  return c;
}

/** least-squares fit of pixel -> map coordinates; null when there are too few (or collinear) points */
export function fit(points: { id: string; col: number; row: number; x: number; y: number }[], order: Order): Fit | null {
  const nt = NTERMS[order];
  if (points.length < nt) return null;

  // centre and scale so the normal equations stay well conditioned
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.col, 0) / n;
  const cy = points.reduce((s, p) => s + p.row, 0) / n;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const s = Math.max(1, ...points.map((p) => Math.max(Math.abs(p.col - cx), Math.abs(p.row - cy))));

  const rows = points.map((p) => terms(order, (p.col - cx) / s, (p.row - cy) / s));
  const normal = Array.from({ length: nt }, (_, i) => Array.from({ length: nt }, (_, j) => rows.reduce((a, r) => a + r[i] * r[j], 0)));
  const bx = Array.from({ length: nt }, (_, i) => rows.reduce((a, r, k) => a + r[i] * (points[k].x - mx), 0));
  const by = Array.from({ length: nt }, (_, i) => rows.reduce((a, r, k) => a + r[i] * (points[k].y - my), 0));
  const ax = solve(normal.map((r) => [...r]), bx);
  const ay = solve(normal.map((r) => [...r]), by);
  if (!ax || !ay) return null;

  const at = (col: number, row: number): [number, number] => {
    const t = terms(order, (col - cx) / s, (row - cy) / s);
    return [mx + t.reduce((a, v, i) => a + v * ax[i], 0), my + t.reduce((a, v, i) => a + v * ay[i], 0)];
  };

  const residuals = points.map((p) => {
    const [x, y] = at(p.col, p.row);
    return { id: p.id, err: Math.hypot(x - p.x, y - p.y) };
  });
  const rmse = Math.sqrt(residuals.reduce((a, r) => a + r.err * r.err, 0) / n);

  let geo: GeoTransform | null = null;
  if (order === 1) {
    const b = ax[1] / s, c = ax[2] / s, e = ay[1] / s, f = ay[2] / s;
    geo = [mx + ax[0] - b * cx - c * cy, b, c, my + ay[0] - e * cx - f * cy, e, f];
  }
  const o = at(cx, cy);
  const dc = at(cx + 1, cy);
  const dr = at(cx, cy + 1);
  return {
    order, n, rmse, residuals, geo, at,
    pixelSize: [Math.hypot(dc[0] - o[0], dc[1] - o[1]), Math.hypot(dr[0] - o[0], dr[1] - o[1])],
    rotation: (Math.atan2(dc[1] - o[1], dc[0] - o[0]) * 180) / Math.PI,
  };
}

const ORDER: Record<Method, Order> = { poly1: 1, poly2: 2, poly3: 3, tps: 1 };

export interface LayerFit {
  fit: Fit | null;
  /** why there is no fit, or a caveat about it */
  note: string;
}

/** the transform for a layer's GCPs using its group's method (TPS is only previewed as an affine) */
export function fitLayer(l: ScanLayer, g: Group): LayerFit {
  const pts = completeGcps(l) as { id: string; col: number; row: number; x: number; y: number }[];
  const order = ORDER[g.method];
  const f = fit(pts, order);
  const need = g.method === "tps" ? MIN_GCPS.tps : NTERMS[order];
  if (!f) {
    return { fit: null, note: pts.length < need ? `${pts.length} of ${need} points with coordinates` : "points are collinear or duplicated" };
  }
  return { fit: f, note: g.method === "tps" ? "TPS is solved by GDAL when warping; this affine is only a preview" : "" };
}
