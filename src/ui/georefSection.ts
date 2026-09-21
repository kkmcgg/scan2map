import { MIN_GCPS, completeGcps, type LayerStore, type Method } from "../layers/store";
import type { GcpEditor } from "../view/gcpEditor";

const METHODS: [Method, string][] = [
  ["poly1", "Affine (poly 1) — 3+ points"],
  ["poly2", "Polynomial 2 — 6+ points"],
  ["poly3", "Polynomial 3 — 10+ points"],
  ["tps", "Thin plate spline — 3+ points"],
];
const num = (s: string) => (s.trim() === "" || Number.isNaN(+s) ? null : +s);

/** The active group's georeferencing: CRS, warp method and control points, shared by its scans. */
export function mountGeoref(root: HTMLElement, store: LayerStore, editor: GcpEditor) {
  let key = "";
  let listKey = "";

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const paintAdd = () => {
    const b = root.querySelector<HTMLButtonElement>("#add");
    if (!b) return;
    b.textContent = editor.adding ? "Click the scan… (Esc to stop)" : "+ Add GCP";
    b.classList.toggle("on", editor.adding);
  };
  editor.onMode = paintAdd;

  function build() {
    const g = store.activeGroup;
    key = g?.id ?? "";
    listKey = "";
    if (!g) { root.replaceChildren(); return; }

    root.innerHTML = `
      <h3></h3>
      <label>GCP CRS <input id="src" type="text" spellcheck="false" placeholder="EPSG:2961"></label>
      <label>Output CRS <input id="dst" type="text" spellcheck="false" placeholder="EPSG:2961"></label>
      <label>Method <select id="method"></select></label>
      <div class="buttons"><button id="add"></button></div>
      <div id="need"></div>
      <div id="gcps"></div>`;
    const method = $<HTMLSelectElement>("#method");
    for (const [v, label] of METHODS) method.add(new Option(label, v));

    $<HTMLInputElement>("#src").onchange = (e) => store.setGeoref(g.id, { srcSrs: (e.target as HTMLInputElement).value.trim() });
    $<HTMLInputElement>("#dst").onchange = (e) => store.setGeoref(g.id, { dstSrs: (e.target as HTMLInputElement).value.trim() });
    method.onchange = () => store.setGeoref(g.id, { method: method.value as Method });
    $("#add").onclick = () => editor.setAdding(!editor.adding);
    paintAdd();
  }

  function buildList() {
    const g = store.activeGroup!;
    $("#gcps").replaceChildren(
      ...g.georef.gcps.map((p, i) => {
        const el = document.createElement("div");
        el.className = "gcp";
        el.innerHTML = `
          <div class="gcp-head"><span>#${i + 1}</span><span class="px"></span><button title="Remove">×</button></div>
          <div class="gcp-xy"><input class="x" type="text" inputmode="decimal" placeholder="x / lon"><input class="y" type="text" inputmode="decimal" placeholder="y / lat"></div>`;
        el.querySelector<HTMLElement>(".gcp-head")!.onclick = () => editor.focus(p.id);
        el.querySelector("button")!.onclick = (e) => { e.stopPropagation(); store.removeGcp(g.id, p.id); };
        el.querySelector<HTMLInputElement>(".x")!.onchange = (e) => store.updateGcp(g.id, p.id, { x: num((e.target as HTMLInputElement).value) });
        el.querySelector<HTMLInputElement>(".y")!.onchange = (e) => store.updateGcp(g.id, p.id, { y: num((e.target as HTMLInputElement).value) });
        return el;
      }),
    );
  }

  function sync() {
    const g = store.activeGroup;
    if (!g || !root.firstElementChild) return;
    const { georef } = g;
    $("h3").textContent = `Georeferencing — ${g.name}`;
    const src = $<HTMLInputElement>("#src");
    const dst = $<HTMLInputElement>("#dst");
    if (document.activeElement !== src) src.value = georef.srcSrs;
    if (document.activeElement !== dst) dst.value = georef.dstSrs;
    $<HTMLSelectElement>("#method").value = georef.method;

    // rebuild the point rows only when points were added/removed, so typing isn't interrupted
    const lk = georef.gcps.map((p) => p.id).join();
    if (lk !== listKey) { listKey = lk; buildList(); }
    georef.gcps.forEach((p, i) => {
      const el = $("#gcps").children[i] as HTMLElement;
      el.querySelector<HTMLElement>(".px")!.textContent = `px ${p.col.toFixed(0)}, ${p.row.toFixed(0)}`;
      const x = el.querySelector<HTMLInputElement>(".x")!;
      const y = el.querySelector<HTMLInputElement>(".y")!;
      if (document.activeElement !== x) x.value = p.x === null ? "" : String(p.x);
      if (document.activeElement !== y) y.value = p.y === null ? "" : String(p.y);
    });

    const have = completeGcps(g).length;
    const need = MIN_GCPS[georef.method];
    const n = $("#need");
    n.textContent = `${have} of ${georef.gcps.length} with coordinates — ${have >= need ? "enough" : `need ${need}`} for ${georef.method}`;
    n.classList.toggle("ok", have >= need);
    paintAdd();
  }

  return () => {
    if ((store.activeGroup?.id ?? "") !== key) build();
    sync();
  };
}
