import "ol/ol.css";
import "./style.css";
import { LayerStore } from "./layers/store";
import { pickFiles, loadLayers, ensureImage } from "./io/load";
import { restore, autosave } from "./io/persist";
import { ScanView } from "./view/scanView";
import { GcpEditor } from "./view/gcpEditor";
import { mountPanel } from "./ui/panel";
import { cvWorker, gdalWorker, cvWorkerIfStarted } from "./workers";

const app = document.getElementById("app")!;
app.innerHTML = `<aside id="panel"></aside><main id="view"></main>`;

const store = new LayerStore();
const scanView = new ScanView(document.getElementById("view")!, store);

const gcpEditor = new GcpEditor(scanView, store);

const panel = mountPanel(document.getElementById("panel")!, store, gcpEditor, async () => {
  try {
    const files = await pickFiles();
    if (!files.length) return;
    const { layers, groups } = await loadLayers(files, (d, n, name) => panel.setStatus(`loading ${d}/${n}: ${name}`));
    store.set(layers, groups);
    cvWorkerIfStarted()?.clear();
    panel.setStatus(`${layers.length} layer${layers.length === 1 ? "" : "s"}`);
  } catch (e) {
    if ((e as DOMException).name === "AbortError") return;
    console.error(e);
    panel.setStatus("load failed — see console");
  }
});

// bring back the last session, then start saving changes to it
(async () => {
  try {
    const saved = await restore();
    if (saved) {
      store.set(saved.layers, saved.groups, saved.activeId);
      if (saved.view) {
        const v = scanView.map.getView();
        v.setCenter(saved.view.center);
        v.setResolution(saved.view.resolution);
      }
      panel.setStatus(`restored ${saved.layers.length} layer${saved.layers.length === 1 ? "" : "s"}`);
    }
  } catch (e) {
    console.warn("session restore failed", e);
  }
  autosave(store, scanView.map, () => panel.setStatus("couldn't cache session (storage full?)"));
})();

// decode the active scan (TIFFs are lazy) and its neighbours so switching is instant
store.subscribe((c) => {
  if (c !== "list" && c !== "active") return;
  const i = store.layers.findIndex((l) => l.id === store.activeId);
  const l = store.layers[i];
  if (!l) return;
  if (!l.url) {
    panel.setStatus(`decoding ${l.name}…`);
    ensureImage(store, l).then(() => store.activeId === l.id && panel.setStatus(""));
  }
  for (const n of [store.layers[i + 1], store.layers[i - 1]]) if (n) ensureImage(store, n);
});

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
  const d = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 }[e.key];
  if (d) { e.preventDefault(); store.step(d); }
});

// dev handle for the console
Object.assign(window, { s2m: { store, cv: cvWorker, gdal: gdalWorker } });