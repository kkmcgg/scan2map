import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature, { type FeatureLike } from "ol/Feature";
import Point from "ol/geom/Point";
import Translate from "ol/interaction/Translate";
import { Style, Circle as CircleStyle, Fill, Stroke, Text } from "ol/style";
import type { LayerStore } from "../layers/store";
import type { ScanView } from "./scanView";

/** Point style shared by the scan and the reference map: orange = no world position yet, green = paired, blue = waiting. */
export function gcpStyle(f: FeatureLike, selectedId: string | null, pendingId: string | null) {
  const id = f.getId();
  const sel = id === selectedId;
  const color = id === pendingId ? "#4c8dff" : f.get("ok") ? "#3ecf8e" : "#ffb020";
  return new Style({
    image: new CircleStyle({
      radius: sel || id === pendingId ? 10 : 8,
      fill: new Fill({ color: color + "cc" }),
      stroke: new Stroke({ color: "#fff", width: sel ? 3 : 2 }),
    }),
    text: new Text({ text: String(f.get("n")), font: "bold 11px system-ui, sans-serif", fill: new Fill({ color: "#111" }) }),
  });
}

/**
 * Places and moves the active layer's GCPs on the scan. A GCP's real-world position is shared by its whole
 * group; each scan has its own pixel placement of it, but adding a new GCP seeds that same pixel position
 * onto every scan in the group at once (scans are assumed to be roughly aligned already) — dragging a point
 * on one scan only nudges that scan's copy to its exact spot.
 * Workflow: click the scan ("+ Add GCP", becomes "pending"), then click the matching place on the reference
 * map, which fills in its world coordinates.
 */
export class GcpEditor {
  adding = false;
  selectedId: string | null = null;
  pendingId: string | null = null;
  private watchers = new Set<() => void>();
  private source = new VectorSource<Feature<Point>>();

  constructor(private view: ScanView, private store: LayerStore) {
    const map = view.map;
    const layer = new VectorLayer({ source: this.source, zIndex: 10, style: (f) => gcpStyle(f, this.selectedId, this.pendingId) });
    map.addLayer(layer);

    const translate = new Translate({ layers: [layer] });
    map.addInteraction(translate);
    translate.on("translateend", (e) => {
      const l = store.active;
      if (!l) return;
      for (const f of e.features.getArray() as Feature<Point>[]) {
        const [px, py] = f.getGeometry()!.getCoordinates();
        store.placeGcp(l.id, f.getId() as string, px, view.stackH - py);
      }
    });

    map.on("singleclick", (e) => {
      const l = store.active;
      if (!this.adding || !l) return;
      const id = store.addGcp(l.id, { col: e.coordinate[0], row: view.stackH - e.coordinate[1] });
      if (id) this.setPending(id);
    });

    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      this.setAdding(false);
      this.setPending(null);
    });

    store.subscribe((c) => {
      if (c === "active" || c === "list" || c === "groups") this.setPending(null);
      if (c === "list" || c === "active" || c === "groups" || c === "gcps") this.sync();
    });
  }

  /** be told when mode/selection/pending change (for the panel and the reference map) */
  watch(fn: () => void) {
    this.watchers.add(fn);
  }
  private notify() {
    this.source.changed();
    this.watchers.forEach((fn) => fn());
  }

  setAdding(on: boolean) {
    if (on === this.adding) return;
    this.adding = on;
    const el = this.view.map.getTargetElement();
    if (el) el.style.cursor = on ? "crosshair" : "";
    this.notify();
  }

  /** the point that the next click on the reference map will position */
  setPending(id: string | null) {
    if (id === this.pendingId) return;
    this.pendingId = id;
    this.notify();
  }

  /** highlight a GCP and bring it into view on the scan (only if it's placed on the active one) */
  focus(id: string) {
    this.selectedId = id;
    const f = this.source.getFeatureById(id);
    if (f) this.view.map.getView().animate({ center: f.getGeometry()!.getCoordinates(), duration: 200 });
    this.notify();
  }

  private sync() {
    const l = this.store.active;
    const g = this.store.activeGroup;
    this.source.clear();
    if (l && g) {
      const numOf = new Map(g.gcps.map((p, i) => [p.id, i + 1]));
      const known = new Map(g.gcps.map((p) => [p.id, p.x !== null && p.y !== null]));
      this.source.addFeatures(
        l.gcpPx.map((px) => {
          const f = new Feature({ geometry: new Point([px.col, this.view.stackH - px.row]), n: numOf.get(px.gcpId) ?? "?", ok: known.get(px.gcpId) ?? false });
          f.setId(px.gcpId);
          return f;
        }),
      );
    }
    this.notify();
  }
}
