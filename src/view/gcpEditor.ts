import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature, { type FeatureLike } from "ol/Feature";
import Point from "ol/geom/Point";
import Translate from "ol/interaction/Translate";
import { Style, Circle as CircleStyle, Fill, Stroke, Text } from "ol/style";
import type { LayerStore } from "../layers/store";
import type { ScanView } from "./scanView";

/** Draws the active group's GCPs on the map; click to add in "add" mode, drag to move. */
export class GcpEditor {
  adding = false;
  onMode?: (adding: boolean) => void;
  private source = new VectorSource<Feature<Point>>();
  private selectedId: string | null = null;

  constructor(private view: ScanView, private store: LayerStore) {
    const map = view.map;
    const layer = new VectorLayer({ source: this.source, zIndex: 10, style: (f) => this.style(f) });
    map.addLayer(layer);

    const translate = new Translate({ layers: [layer] });
    map.addInteraction(translate);
    translate.on("translateend", (e) => {
      const g = store.activeGroup;
      if (!g) return;
      for (const f of e.features.getArray() as Feature<Point>[]) {
        const [px, py] = f.getGeometry()!.getCoordinates();
        store.updateGcp(g.id, f.getId() as string, { col: px, row: view.stackH - py });
      }
    });

    map.on("singleclick", (e) => {
      const g = store.activeGroup;
      if (!this.adding || !g) return;
      store.addGcp(g.id, { col: e.coordinate[0], row: view.stackH - e.coordinate[1] });
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.setAdding(false);
    });

    store.subscribe((c) => {
      if (c === "list" || c === "active" || c === "groups" || c === "settings") this.sync();
    });
  }

  setAdding(on: boolean) {
    if (on === this.adding) return;
    this.adding = on;
    const el = this.view.map.getTargetElement();
    if (el) el.style.cursor = on ? "crosshair" : "";
    this.onMode?.(on);
  }

  /** highlight a GCP and bring it into view */
  focus(id: string) {
    this.selectedId = id;
    this.source.changed();
    const f = this.source.getFeatureById(id);
    if (f) this.view.map.getView().animate({ center: f.getGeometry()!.getCoordinates(), duration: 200 });
  }

  private sync() {
    const g = this.store.activeGroup;
    this.source.clear();
    if (!g) return;
    this.source.addFeatures(
      g.georef.gcps.map((p, i) => {
        const f = new Feature({ geometry: new Point([p.col, this.view.stackH - p.row]), n: i + 1, ok: p.x !== null && p.y !== null });
        f.setId(p.id);
        return f;
      }),
    );
  }

  private style(f: FeatureLike) {
    const sel = f.getId() === this.selectedId;
    return new Style({
      image: new CircleStyle({
        radius: sel ? 10 : 8,
        fill: new Fill({ color: f.get("ok") ? "#3ecf8ecc" : "#ffb020cc" }), // green once it has coordinates
        stroke: new Stroke({ color: "#fff", width: sel ? 3 : 2 }),
      }),
      text: new Text({ text: String(f.get("n")), font: "bold 11px system-ui, sans-serif", fill: new Fill({ color: "#111" }) }),
    });
  }
}
