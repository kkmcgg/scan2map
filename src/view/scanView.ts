import OlMap from "ol/Map";
import View from "ol/View";
import ImageLayer from "ol/layer/Image";
import Static from "ol/source/ImageStatic";
import Projection from "ol/proj/Projection";
import { getCenter } from "ol/extent";
import { defaults as defaultControls } from "ol/control/defaults";
import { shownUrl, type LayerStore } from "../layers/store";

/** Shows the active scan only, in pixel space, top-left aligned. row = stackH - y. */
export class ScanView {
  readonly map: OlMap;
  private layer = new ImageLayer<Static>();
  private projection: Projection | null = null;
  private stackW = 0;
  stackH = 0; // tallest scan; a scan pixel row r sits at map y = stackH - r
  private shown = ""; // id|url of what the layer currently holds

  constructor(target: HTMLElement, private store: LayerStore) {
    this.map = new OlMap({
      target,
      layers: [this.layer],
      view: new View(),
      controls: defaultControls({ attribution: false, rotate: false }),
    });
    store.subscribe((c, id) => {
      if (c === "list") this.rebuild();
      else if (c === "groups") this.reextent();
      else if (c === "active" || (c === "image" && id === store.activeId)) this.show();
    });
  }

  /** a mosaic can be bigger than any scan: rebuild only when the shared extent actually changes */
  private reextent() {
    const layers = this.store.shown;
    const w = Math.max(0, ...layers.map((l) => l.width));
    const h = Math.max(0, ...layers.map((l) => l.height));
    if (w !== this.stackW || h !== this.stackH) this.rebuild();
    else this.show();
  }

  private rebuild() {
    const layers = this.store.shown;
    this.shown = "";
    if (!layers.length) { this.layer.setSource(null); this.stackW = this.stackH = 0; return; }

    const w = (this.stackW = Math.max(...layers.map((l) => l.width)));
    this.stackH = Math.max(...layers.map((l) => l.height));
    const extent = [0, 0, w, this.stackH];
    this.projection = new Projection({ code: "scan-px", units: "pixels", extent });

    this.show();
    const view = new View({ projection: this.projection, center: getCenter(extent), extent, constrainOnlyCenter: true });
    this.map.setView(view);
    view.fit(extent, { padding: [20, 20, 20, 20] });
  }

  private show() {
    const l = this.store.active;
    const url = l && shownUrl(l);
    if (!l || !url || !this.projection) return; // TIFF still decoding: keep the previous image up
    const key = `${l.id}|${url}`;
    if (key === this.shown) return;
    this.shown = key;
    this.layer.setSource(
      new Static({
        url,
        projection: this.projection,
        imageExtent: [0, this.stackH - l.height, l.width, this.stackH],
        interpolate: false,
      }),
    );
  }
}
