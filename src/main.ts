import "ol/ol.css";
import "./style.css";
import { LayerStore } from "./layers/store";
import { pickFiles, loadLayers } from "./io/load";
import { ScanView } from "./view/scanView";
import { mountPanel } from "./ui/panel";
import { cvWorker, gdalWorker, cvWorkerIfStarted } from "./workers";

const app = document.getElementById("app")!;
app.innerHTML = `<aside id="panel"></aside><main id="view"></main>`;

const store = new LayerStore();
new ScanView(document.getElementById("view")!, store);

const panel = mountPanel(document.getElementById("panel")!, store, async () => {
  try {
    const files = await pickFiles();
    if (!files.length) return;
    const layers = await loadLayers(files, (d, n, name) => panel.setStatus(`loading ${d}/${n}: ${name}`));
    store.set(layers);
    cvWorkerIfStarted()?.clear();
    panel.setStatus(`${layers.length} layer${layers.length === 1 ? "" : "s"}`);
  } catch (e) {
    if ((e as DOMException).name === "AbortError") return;
    console.error(e);
    panel.setStatus("load failed — see console");
  }
});

// dev handle for the console
Object.assign(window, { s2m: { store, cv: cvWorker, gdal: gdalWorker } });