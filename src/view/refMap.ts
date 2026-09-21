import OlMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import ImageLayer from "ol/layer/Image";
import ImageCanvas from "ol/source/ImageCanvas";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import Translate from "ol/interaction/Translate";
import { fromLonLat } from "ol/proj";
import { defaults as defaultControls } from "ol/control/defaults";
import { shownUrl, type LayerStore, type ScanLayer } from "../layers/store";
import { fromRef, toRef, crsKnown } from "../geo/crs";
import { fitLayer } from "../geo/transform";
import { ensureImage } from "../io/load";
import { gcpStyle, type GcpEditor } from "./gcpEditor";

const VIEW_KEY = "s2m.refview";
const PROXY_MAX = 4096; // longest side of the copy of a scan that is drawn on the map

/** scan = scan only, split = scan + basemap (active scan overlaid), map = basemap only (every georeferenced scan overlaid) */
export type Mode = "scan" | "split" | "map";

/** A scan's pixel grid pushed through its transform and into web mercator: (n+1)² vertices, x/y interleaved. */
interface Mesh { sig: string; n: number; pts: Float64Array | null }
interface Proxy { url: string; bmp: ImageBitmap | null }

/**
 * Real-world basemap (OpenStreetMap, EPSG:3857). Clicking it positions the pending GCP. Scans are reprojected
 * onto it by warping a triangle mesh through each layer's fitted transform and CRS conversion.
 */
export class RefMap {
  readonly map: OlMap;
  mode: Mode = "scan";
  onMessage?: (text: string) => void;
  onLayout?: () => void; // the split changed, so the scan map should re-measure too
  private modeWatchers = new Set<() => void>();
  private root: HTMLElement;
  private points = new VectorSource<Feature<Point>>();
  private overlay: ImageCanvas;
  private overlayLayer: ImageLayer<ImageCanvas>;
  private overlayOn = true;
  private meshes = new Map<string, Mesh>();
  private proxies = new Map<string, Proxy>();

  constructor(root: HTMLElement, private store: LayerStore, private editor: GcpEditor) {
    this.root = root;
    root.innerHTML = `
      <div id="reftools">
        <input id="goto" type="text" placeholder="Go to a place, or lat, lon" spellcheck="false">
        <label><input id="ovl" type="checkbox" checked> scans</label>
        <input id="opa" type="range" min="0.1" max="1" step="0.05" value="0.7" title="Scan opacity over the basemap">
        <button id="zoomto"></button>
      </div>
      <div id="refmap"></div>`;
    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const goto = $<HTMLInputElement>("#goto");
    goto.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter" && goto.value.trim()) this.goTo(goto.value.trim()); };
    $<HTMLInputElement>("#ovl").onchange = (e) => { this.overlayOn = (e.target as HTMLInputElement).checked; this.overlay.refresh(); };
    $<HTMLInputElement>("#opa").oninput = (e) => this.overlayLayer.setOpacity(+(e.target as HTMLInputElement).value);
    $<HTMLButtonElement>("#zoomto").onclick = () => this.zoomToScans();
    this.paintZoomBtn();

    let start = { center: fromLonLat([-63.6, 44.9]), zoom: 6 }; // Nova Scotia
    try {
      const s = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
      if (s?.center && s.zoom) start = s;
    } catch { /* first run */ }

    this.overlay = new ImageCanvas({ canvasFunction: (extent, _res, _ratio, size) => this.draw(extent, size) });
    this.overlayLayer = new ImageLayer({ source: this.overlay, opacity: 0.7 });
    const points = new VectorLayer({ source: this.points, zIndex: 10, style: (f) => gcpStyle(f, editor.selectedId, editor.pendingId) });
    this.map = new OlMap({
      target: $("#refmap"),
      layers: [new TileLayer({ source: new OSM() }), this.overlayLayer, points],
      view: new View(start),
      controls: defaultControls({ rotate: false }),
    });
    this.map.on("moveend", () => {
      const v = this.map.getView();
      try { localStorage.setItem(VIEW_KEY, JSON.stringify({ center: v.getCenter(), zoom: v.getZoom() })); } catch { /* optional */ }
    });

    // click = position the pending GCP
    this.map.on("singleclick", (e) => {
      const l = store.active;
      const g = store.activeGroup;
      const id = editor.pendingId;
      if (!l || !g || !id) return;
      const w = fromRef(g.srcSrs, e.coordinate[0], e.coordinate[1]);
      if (!w) return this.onMessage?.(`CRS "${g.srcSrs}" isn't known yet — check the GCP CRS field`);
      store.updateGcp(l.id, id, { x: w[0], y: w[1] });
      editor.setPending(null);
    });

    const translate = new Translate({ layers: [points] });
    this.map.addInteraction(translate);
    translate.on("translateend", (e) => {
      const l = store.active;
      const g = store.activeGroup;
      if (!l || !g) return;
      for (const f of e.features.getArray() as Feature<Point>[]) {
        const [X, Y] = f.getGeometry()!.getCoordinates();
        const w = fromRef(g.srcSrs, X, Y);
        if (w) store.updateGcp(l.id, f.getId() as string, { x: w[0], y: w[1] });
      }
    });

    store.subscribe((c) => {
      if (c === "list" || c === "groups") this.prune();
      if (c !== "select") this.sync();
    });
    editor.watch(() => this.points.changed());
  }

  // ---- layout ----

  get open() {
    return this.mode !== "scan";
  }

  setOpen(on: boolean) {
    this.setMode(on ? "split" : "scan");
  }

  watchMode(fn: () => void) {
    this.modeWatchers.add(fn);
  }

  setMode(mode: Mode) {
    this.mode = mode;
    const stage = this.root.closest("#stage");
    stage?.classList.toggle("split", mode === "split");
    stage?.classList.toggle("mapview", mode === "map");
    this.paintZoomBtn();
    this.modeWatchers.forEach((fn) => fn());
    this.sync();
    requestAnimationFrame(() => {
      this.map.updateSize();
      this.onLayout?.();
    });
  }

  private paintZoomBtn() {
    this.root.querySelector<HTMLButtonElement>("#zoomto")!.textContent = this.mode === "map" ? "Zoom to all scans" : "Zoom to scan";
  }

  // ---- navigation ----

  setOverlay(on: boolean) {
    this.overlayOn = on;
    this.overlay.refresh();
  }

  /** "lat, lon" or a place name (looked up with OpenStreetMap's Nominatim) */
  async goTo(query: string) {
    const nums = query.match(/-?\d+(\.\d+)?/g)?.map(Number);
    if (nums?.length === 2 && /^[\s\d.,+\-°]+$/.test(query)) {
      return this.flyTo(fromLonLat([nums[1], nums[0]]), 12);
    }
    try {
      const r = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`)).json();
      if (!r[0]) return this.onMessage?.(`no place found for "${query}"`);
      this.flyTo(fromLonLat([+r[0].lon, +r[0].lat]), 12);
    } catch {
      this.onMessage?.("place search failed (offline?) — try 'lat, lon'");
    }
  }

  private flyTo(center: number[], zoom: number) {
    this.map.getView().animate({ center, zoom, duration: 300 });
  }

  /** centre the basemap on a GCP's real-world position (opens the basemap if it is hidden) */
  find(id: string) {
    const l = this.store.active;
    const g = this.store.activeGroup;
    const p = l?.gcps.find((p) => p.id === id);
    if (!l || !g || !p) return;
    if (p.x === null || p.y === null) return this.onMessage?.("that point has no world position yet — click the basemap to place it");
    const w = toRef(g.srcSrs, p.x, p.y);
    if (!w) return this.onMessage?.(`CRS "${g.srcSrs}" isn't known yet — check the GCP CRS field`);
    if (this.mode === "scan") this.setMode("split");
    this.flyTo(w, Math.max(this.map.getView().getZoom() ?? 0, 15));
  }

  /** fit the basemap to the active scan (or every georeferenced scan in map view) */
  zoomToScans() {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const l of this.targets()) {
      const pts = this.mesh(l)?.pts;
      if (!pts) continue;
      for (let i = 0; i < pts.length; i += 2) {
        box[0] = Math.min(box[0], pts[i]); box[1] = Math.min(box[1], pts[i + 1]);
        box[2] = Math.max(box[2], pts[i]); box[3] = Math.max(box[3], pts[i + 1]);
      }
    }
    if (!Number.isFinite(box[0])) return this.onMessage?.("nothing is georeferenced yet — pair at least 3 points");
    this.map.getView().fit(box, { padding: [40, 40, 40, 40], duration: 300 });
  }

  // ---- markers ----

  /** the active layer's points that already have world coordinates, on the basemap */
  private sync() {
    const l = this.store.active;
    const g = this.store.activeGroup;
    this.points.clear();
    if (l && g && crsKnown(g.srcSrs)) {
      l.gcps.forEach((p, i) => {
        if (p.x === null || p.y === null) return;
        const w = toRef(g.srcSrs, p.x, p.y);
        if (!w) return;
        const f = new Feature({ geometry: new Point(w), n: i + 1, ok: true });
        f.setId(p.id);
        this.points.addFeature(f);
      });
    }
    this.overlay.refresh();
  }

  // ---- reprojected scans ----

  /** split shows the active scan; map view shows every scan */
  private targets(): ScanLayer[] {
    if (this.mode === "map") return this.store.shown;
    const l = this.store.active;
    return l ? [l] : [];
  }

  private mesh(l: ScanLayer): Mesh | null {
    const g = this.store.group(l.groupId);
    if (!g) return null;
    const sig = [l.width, l.height, g.method, g.srcSrs, ...l.gcps.map((p) => `${p.col},${p.row},${p.x},${p.y}`)].join("|");
    const have = this.meshes.get(l.id);
    if (have?.sig === sig) return have;

    const mesh: Mesh = { sig, n: g.method === "poly1" ? 16 : 24, pts: null };
    const { fit } = fitLayer(l, g);
    if (fit && crsKnown(g.srcSrs)) {
      const n = mesh.n;
      const pts = new Float64Array((n + 1) * (n + 1) * 2);
      let ok = true;
      for (let j = 0; j <= n && ok; j++) {
        for (let i = 0; i <= n; i++) {
          const [x, y] = fit.at((l.width * i) / n, (l.height * j) / n);
          const w = toRef(g.srcSrs, x, y);
          if (!w) { ok = false; break; }
          pts[(j * (n + 1) + i) * 2] = w[0];
          pts[(j * (n + 1) + i) * 2 + 1] = w[1];
        }
      }
      if (ok) mesh.pts = pts;
    }
    this.meshes.set(l.id, mesh);
    return mesh;
  }

  /** a downscaled copy of the scan to paint from; loads in the background and redraws when ready */
  private proxy(l: ScanLayer): ImageBitmap | null {
    const url = shownUrl(l);
    if (!url) { ensureImage(this.store, l); return null; } // a TIFF that hasn't been decoded yet
    const have = this.proxies.get(l.id);
    if (have?.url === url) return have.bmp;
    have?.bmp?.close();
    const next: Proxy = { url, bmp: null };
    this.proxies.set(l.id, next);
    const s = Math.min(1, PROXY_MAX / Math.max(l.width, l.height));
    fetch(url)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b, { resizeWidth: Math.round(l.width * s), resizeHeight: Math.round(l.height * s), resizeQuality: "medium" }))
      .then((bmp) => {
        if (this.proxies.get(l.id) !== next) return bmp.close();
        next.bmp = bmp;
        this.overlay.refresh();
      })
      .catch((e) => console.warn(`couldn't prepare ${l.name} for the map`, e));
    return null;
  }

  /** forget meshes/copies of layers that no longer exist */
  private prune() {
    const ids = new Set(this.store.layers.map((l) => l.id));
    for (const [id, p] of this.proxies) if (!ids.has(id)) { p.bmp?.close(); this.proxies.delete(id); }
    for (const id of this.meshes.keys()) if (!ids.has(id)) this.meshes.delete(id);
  }

  private draw(extent: number[], size: number[]): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = size[0];
    canvas.height = size[1];
    if (!this.overlayOn || this.mode === "scan") return canvas;
    const ctx = canvas.getContext("2d")!;
    const sx = size[0] / (extent[2] - extent[0]);
    const sy = size[1] / (extent[3] - extent[1]);

    for (const l of this.targets()) {
      const mesh = this.mesh(l);
      if (!mesh?.pts) continue;
      const n = mesh.n;
      // vertex k in canvas pixels
      const cx = (k: number) => (mesh.pts![k * 2] - extent[0]) * sx;
      const cy = (k: number) => (extent[3] - mesh.pts![k * 2 + 1]) * sy;

      const bmp = this.proxy(l);
      if (bmp) {
        const scale = bmp.width / l.width;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
            const s = (k: number) => [((k % (n + 1)) * l.width * scale) / n, (((k / (n + 1)) | 0) * l.height * scale) / n];
            for (const t of [[a, b, c], [b, d, c]]) {
              const xs = t.map(cx), ys = t.map(cy);
              if (Math.max(...xs) < 0 || Math.min(...xs) > size[0] || Math.max(...ys) < 0 || Math.min(...ys) > size[1]) continue;
              triangle(ctx, bmp, t.map(s), t.map((_, q) => [xs[q], ys[q]]));
            }
          }
        }
      }

      // outline: the active scan stands out
      ctx.save();
      ctx.lineWidth = l.id === this.store.activeId ? 2 : 1;
      ctx.strokeStyle = l.id === this.store.activeId ? "#4c8dff" : "#ffffffaa";
      ctx.beginPath();
      for (const k of [0, n, (n + 1) * (n + 1) - 1, (n + 1) * n]) (k === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, cx(k), cy(k));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    return canvas;
  }
}

/** paint the source triangle s (image px) onto the destination triangle d (canvas px) with an affine map */
function triangle(ctx: CanvasRenderingContext2D, img: ImageBitmap, s: number[][], d: number[][]) {
  const ux = s[1][0] - s[0][0], uy = s[1][1] - s[0][1];
  const vx = s[2][0] - s[0][0], vy = s[2][1] - s[0][1];
  const det = ux * vy - vx * uy;
  if (!det) return;
  const px = d[1][0] - d[0][0], py = d[1][1] - d[0][1];
  const qx = d[2][0] - d[0][0], qy = d[2][1] - d[0][1];
  const a = (px * vy - qx * uy) / det;
  const c = (qx * ux - px * vx) / det;
  const b = (py * vy - qy * uy) / det;
  const e = (qy * ux - py * vx) / det;
  ctx.save();
  // grow the clip a little so neighbouring triangles overlap instead of leaving hairline seams
  const mx = (d[0][0] + d[1][0] + d[2][0]) / 3, my = (d[0][1] + d[1][1] + d[2][1]) / 3;
  ctx.beginPath();
  d.forEach(([x, y], i) => {
    const len = Math.hypot(x - mx, y - my) || 1;
    const gx = x + ((x - mx) / len) * 0.7, gy = y + ((y - my) / len) * 0.7;
    if (i === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
  });
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(a, b, c, e, d[0][0] - a * s[0][0] - c * s[0][1], d[0][1] - b * s[0][0] - e * s[0][1]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
