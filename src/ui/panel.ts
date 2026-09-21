import type { LayerStore, ScanLayer } from "../layers/store";
import { cvWorker } from "../workers";

interface Row { li: HTMLLIElement; cb: HTMLInputElement; range: HTMLInputElement }

export function mountPanel(root: HTMLElement, store: LayerStore, onOpen: () => void) {
  root.innerHTML = `
    <header>
      <button id="open">Open folder…</button>
      <span id="status"></span>
    </header>
    <ul id="list"></ul>
    <section id="proc"></section>
    <footer>Alt+click checkbox to solo</footer>`;
  const list = root.querySelector<HTMLUListElement>("#list")!;
  const proc = root.querySelector<HTMLElement>("#proc")!;
  const status = root.querySelector<HTMLSpanElement>("#status")!;
  root.querySelector<HTMLButtonElement>("#open")!.onclick = onOpen;
  const setStatus = (t: string) => (status.textContent = t);

  const rows = new Map<string, Row>();

  function row(l: ScanLayer): HTMLLIElement {
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="checkbox" title="visible">
      <span class="name"></span>
      <input type="range" min="0" max="1" step="0.01" title="opacity">`;
    const [cb, range] = li.querySelectorAll("input");
    const name = li.querySelector<HTMLSpanElement>(".name")!;
    name.textContent = l.name;
    name.title = `${l.file.name} — ${l.width}×${l.height}`;

    cb.onclick = (e) => {
      if (e.altKey) { e.preventDefault(); store.solo(l.id); }
    };
    cb.onchange = () => store.update(l.id, { visible: cb.checked });
    range.oninput = () => store.update(l.id, { opacity: +range.value });
    li.onclick = (e) => {
      if ((e.target as HTMLElement).tagName !== "INPUT") store.setActive(l.id);
    };

    rows.set(l.id, { li, cb, range });
    return li;
  }

  function render() {
    rows.clear();
    list.replaceChildren(...store.layers.map(row));
    refresh();
  }

  function refresh() {
    for (const l of store.layers) {
      const r = rows.get(l.id);
      if (!r) continue;
      r.li.classList.toggle("active", l.id === store.activeId);
      r.cb.checked = l.visible;
      if (document.activeElement !== r.range) r.range.value = String(l.opacity);
    }
  }

  function renderProc() {
    const l = store.active;
    if (!l) { proc.replaceChildren(); return; }
    proc.innerHTML = `
      <h3></h3>
      <label>Median (1 = off) <input id="median" type="number" min="1" max="31" step="2"></label>
      <label>k-means (0 = off) <input id="k" type="number" min="0" max="64" step="1"></label>
      <div class="buttons"><button id="run">Preview</button><button id="revert">Revert</button></div>
      <div id="palette"></div>`;
    proc.querySelector("h3")!.textContent = l.name;
    const median = proc.querySelector<HTMLInputElement>("#median")!;
    const k = proc.querySelector<HTMLInputElement>("#k")!;
    const run = proc.querySelector<HTMLButtonElement>("#run")!;
    median.value = String(l.proc.median);
    k.value = String(l.proc.k);

    run.onclick = async () => {
      store.setProc(l.id, { median: +median.value, k: +k.value });
      run.disabled = true;
      setStatus("processing… (first run loads OpenCV)");
      try {
        const r = await cvWorker().process(l.id, l.file, { ...l.proc });
        store.setDisplay(l.id, URL.createObjectURL(r.blob), r.palette);
        setStatus(`${l.name}: ${r.ms} ms`);
      } catch (e) {
        console.error(e);
        setStatus("processing failed — see console");
      } finally {
        run.disabled = false;
      }
    };
    proc.querySelector<HTMLButtonElement>("#revert")!.onclick = () => store.setDisplay(l.id, null, null);

    const pal = proc.querySelector<HTMLDivElement>("#palette")!;
    for (const e of l.palette ?? []) {
      const s = document.createElement("span");
      s.className = "swatch";
      s.style.background = `rgb(${e.rgb})`;
      s.title = `rgb(${e.rgb.join(", ")}) — ${(e.share * 100).toFixed(1)}%`;
      pal.append(s);
    }
  }

  store.subscribe((c, id) => {
    if (c === "list") { render(); renderProc(); }
    else if (c === "active") { refresh(); renderProc(); }
    else if (c === "image") { if (id === store.activeId) renderProc(); }
    else refresh();
  });

  return { setStatus };
}