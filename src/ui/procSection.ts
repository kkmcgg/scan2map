import { sameProc, type LayerStore } from "../layers/store";
import { cvWorker } from "../workers";

/** The active group's processing chain: shared by every scan in it. */
export function mountProc(root: HTMLElement, store: LayerStore, setStatus: (t: string) => void) {
  let key = "";
  let busy = false;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const keyNow = () => {
    const g = store.activeGroup;
    const l = store.active;
    return g && l ? `${g.id}|${l.id}` : "";
  };

  function build() {
    const g = store.activeGroup;
    const l = store.active;
    key = keyNow();
    if (!g || !l) { root.replaceChildren(); return; }

    root.innerHTML = `
      <h3>Processing</h3>
      <label>Median (1 = off) <input id="median" type="number" min="1" max="31" step="2"></label>
      <label>k-means (0 = off) <input id="k" type="number" min="0" max="64" step="1"></label>
      <div class="buttons">
        <button id="run" title="Run the chain on the selected scan">Preview scan</button>
        <button id="all"></button>
        <button id="revert">Revert</button>
      </div>
      <div id="palette"></div>`;
    const median = $<HTMLInputElement>("#median");
    const k = $<HTMLInputElement>("#k");
    median.onchange = () => store.setProc(g.id, { median: +median.value });
    k.onchange = () => store.setProc(g.id, { k: +k.value });

    $("#run").onclick = () => run([l.id], l.name);
    $("#all").onclick = () => run(store.members(g.id).map((m) => m.id), g.name);
    $("#revert").onclick = () => store.setDisplay(l.id, null, null);
  }

  /** process scans one after another with the group's chain as it is now */
  async function run(ids: string[], label: string) {
    const g = store.activeGroup;
    if (!g || busy) return;
    const chain = { ...g.proc };
    busy = true;
    sync();
    try {
      for (const [i, id] of ids.entries()) {
        const l = store.layers.find((x) => x.id === id);
        if (!l) continue;
        setStatus(`${label}: processing ${i + 1}/${ids.length}${i ? "" : " (first run loads OpenCV)"}`);
        const r = await cvWorker().process(l.id, l.file, chain);
        store.setDisplay(l.id, URL.createObjectURL(r.blob), r.palette, chain);
      }
      setStatus(`${label}: processed ${ids.length}`);
    } catch (e) {
      console.error(e);
      setStatus("processing failed — see console");
    } finally {
      busy = false;
      sync();
    }
  }

  function sync() {
    const g = store.activeGroup;
    const l = store.active;
    if (!g || !l || !root.firstElementChild) return;
    const median = $<HTMLInputElement>("#median");
    const k = $<HTMLInputElement>("#k");
    if (document.activeElement !== median) median.value = String(g.proc.median);
    if (document.activeElement !== k) k.value = String(g.proc.k);
    $("#all").textContent = `Process group (${store.members(g.id).length})`;
    root.querySelectorAll("button").forEach((b) => (b.disabled = busy));
    $("h3").textContent = `Processing — ${g.name}` + (l.applied && !sameProc(l.applied, g.proc) ? " (preview is outdated)" : "");

    const pal = $("#palette");
    pal.replaceChildren();
    for (const e of l.palette ?? []) {
      const s = document.createElement("span");
      s.className = "swatch";
      s.style.background = `rgb(${e.rgb})`;
      s.title = `rgb(${e.rgb.join(", ")}) — ${(e.share * 100).toFixed(1)}%`;
      pal.append(s);
    }
  }

  return () => {
    if (keyNow() !== key) build();
    sync();
  };
}
