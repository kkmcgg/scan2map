import OlMap from "ol/Map";
import View from "ol/View";
import ImageLayer from "ol/layer/Image";
import Static from "ol/source/ImageStatic";
import Projection from "ol/proj/Projection";
import { getCenter } from "ol/extent";
import { defaults as defaultControls } from "ol/control/defaults";
import type { LayerStore, ScanLayer } from "../layers/store";

/** Scans stacked in pixel space, top-left aligned. row = stackH - y. */
export class ScanView {
  readonly map: OlMap;
  private olLayers = new Map<string, ImageLayer<Static>>();
  private projection: Projection | null = null;
  private stackH = 0;

  constructor(target: HTMLElement, private store: LayerStore) {
    this.map = new OlMap({
      target,
      layers: [],
      view: new View(),
      controls: defaultControls({ attribution: false, rotate: false }),
    });
    store.subscribe((c, id) => {
      if (c === "list") this.rebuild();
      else if (c === "props") this.sync();
      else if (c === "image" && id) this.refreshImage(id);
    });
  }

  private source(l: ScanLayer) {
    return new Static({
      url: l.displayUrl,
      projection: this.projection!,
      imageExtent: [0, this.stackH - l.height, l.width, this.stackH],
      interpolate: false,
    });
  }

  private rebuild() {
    this.map.getLayers().clear();
    this.olLayers.clear();
    const { layers } = this.store;
    if (!layers.length) return;

    const w = Math.max(...layers.map((l) => l.width));
    this.stackH = Math.max(...layers.map((l) => l.height));
    const extent = [0, 0, w, this.stackH];
    this.projection = new Projection({ code: "scan-px", units: "pixels", extent });

    layers.forEach((l, i) => {
      const lyr = new ImageLayer({ source: this.source(l), zIndex: layers.length - i });
      this.olLayers.set(l.id, lyr);
      this.map.addLayer(lyr);
    });
    this.sync();

    const view = new View({ projection: this.projection, center: getCenter(extent), extent, constrainOnlyCenter: true });
    this.map.setView(view);
    view.fit(extent, { padding: [20, 20, 20, 20] });
  }

  private refreshImage(id: string) {
    const l = this.store.layers.find((l) => l.id === id);
    const o = this.olLayers.get(id);
    if (l && o) o.setSource(this.source(l));
  }

  private sync() {
    for (const l of this.store.layers) {
      const o = this.olLayers.get(l.id);
      o?.setVisible(l.visible);
      o?.setOpacity(l.opacity);
    }
  }
}