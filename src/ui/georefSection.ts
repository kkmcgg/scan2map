import { MIN_GCPS, completeGcps, type LayerStore, type Method } from "../layers/store";
import { crsKnown, resolveCrs } from "../geo/crs";
import { fitLayer } from "../geo/transform";
import type { GcpEditor } from "../view/gcpEditor";
import type { RefMap } from "../view/refMap";

const METHODS: [Method, string][] = [
  ["poly1", "Affine (poly 1) — 3+ points"],
  ["poly2", "Polynomial 2 — 6+ points"],
  ["poly3", "Polynomial 3 — 10+ points"],
  ["tps", "Thin plate spline — 3+ points"],
];
const num = (s: string) => (s.trim() === "" || Number.isNaN(+s) ? null : +s);
const sig = (v: number) => (v >= 100 ? v.toFixed(1) : v.toPrecision(3));

/** Control points for the active layer, and the CRS/warp method its group shares. */
export function mountGeoref(root: HTMLElement, store: LayerStore, editor: GcpEditor, ref: RefMap) {
  let key = "";
  let listKey = "";
  const lookup = new Map<string, "loading" | "failed">();

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const keyNow = () => (store.active && store.activeGroup ? `${store.active.id}|${store.activeGroup.id}` : "");

  function build() {
    const l = store.active;
    const g = store.activeGroup;
    key = keyNow();
    listKey = "";
    if (!l || !g) { root.replaceChildren(); return; }

    root.innerHTML = `
      <h3></h3>
      <label>GCP CRS <input id="src" type="text" spellcheck="false" placeholder="EPSG:2961"></label>
      <div id="srcstat" class="note"></div>
      <label>Output CRS <input id="dst" type="text" spellcheck="false" placeholder="EPSG:2961"></label>
      <label>Method <select id="method"></select></label>
      <div class="buttons"><button id="ref"></button><button id="add"></button></div>
      <div id="hint" class="note"></div>
      <div id="need"></div>
      <div id="gcps"></div>
      <div id="fit"></div>`;
    const method = $<HTMLSelectElement>("#method");
    for (const [v, label] of METHODS) method.add(new Option(label, v));

    $<HTMLInputElement>("#src").onchange = (e) => store.setGeoref(g.id, { srcSrs: (e.target as HTMLInputElement).value.trim() });
    $<HTMLInputElement>("#dst").onchange = (e) => store.setGeoref(g.id, { dstSrs: (e.target as HTMLInputElement).value.trim() });
    method.onchange = () => store.setGeoref(g.id, { method: method.value as Method });
    $("#ref").onclick = () => { ref.setOpen(!ref.open); sync(); };
    $("#add").onclick = () => editor.setAdding(!editor.adding);
  }

  function buildList() {
    const l = store.active!;
    $("#gcps").replaceChildren(
      ...l.gcps.map((p, i) => {
        const el = document.createElement("div");
        el.className = "gcp";
        el.innerHTML = `
          <div class="gcp-head" title="Click to re-place this point on the reference map">
            <span>#${i + 1}</span><span class="px"></span><span class="err"></span><button class="find" title="Find this point on the scan and the map">⌖</button><button class="rm" title="Remove">×</button>
          </div>
          <div class="gcp-xy"><input class="x" type="text" inputmode="decimal" placeholder="x / lon"><input class="y" type="text" inputmode="decimal" placeholder="y / lat"></div>`;
        el.querySelector<HTMLElement>(".gcp-head")!.onclick = () => { editor.focus(p.id); editor.setPending(p.id); };
        el.querySelector<HTMLButtonElement>(".find")!.onclick = (e) => { e.stopPropagation(); editor.focus(p.id); ref.find(p.id); };
        el.querySelector<HTMLButtonElement>(".rm")!.onclick = (e) => { e.stopPropagation(); store.removeGcp(l.id, p.id); };
        el.querySelector<HTMLInputElement>(".x")!.onchange = (e) => store.updateGcp(l.id, p.id, { x: num((e.target as HTMLInputElement).value) });
        el.querySelector<HTMLInputElement>(".y")!.onchange = (e) => store.updateGcp(l.id, p.id, { y: num((e.target as HTMLInputElement).value) });
        return el;
      }),
    );
  }

  function crsStatus(code: string) {
    if (crsKnown(code)) return { text: "✓ CRS known", ok: true };
    const st = lookup.get(code);
    if (!st) {
      lookup.set(code, "loading");
      resolveCrs(code).then((ok) => {
        if (ok) lookup.delete(code); else lookup.set(code, "failed");
        store.setGeoref(store.activeGroup?.id ?? "", {}); // re-render; also repositions points on the basemap
      });
      return { text: "looking up definition…", ok: false };
    }
    return st === "loading"
      ? { text: "looking up definition…", ok: false }
      : { text: "✗ unknown CRS — enter an EPSG code, or a proj string like +proj=tmerc …", ok: false };
  }

  function sync() {
    const l = store.active;
    const g = store.activeGroup;
    if (!l || !g || !root.firstElementChild) return;
    $("h3").textContent = `Georeferencing — ${l.name}`;
    const src = $<HTMLInputElement>("#src");
    const dst = $<HTMLInputElement>("#dst");
    if (document.activeElement !== src) src.value = g.srcSrs;
    if (document.activeElement !== dst) dst.value = g.dstSrs;
    $<HTMLSelectElement>("#method").value = g.method;
    const st = crsStatus(g.srcSrs);
    $("#srcstat").textContent = st.text;
    $("#srcstat").classList.toggle("ok", st.ok);

    $("#ref").textContent = ref.open ? "Hide reference map" : "Show reference map";
    $("#ref").classList.toggle("on", ref.open);
    $("#add").textContent = editor.adding ? "Click the scan… (Esc to stop)" : "+ Add GCP";
    $("#add").classList.toggle("on", editor.adding);
    $("#hint").textContent = editor.pendingId
      ? `Now click the matching place on the reference map${ref.open ? "" : " (open it first)"}, or type x / y below.`
      : editor.adding
        ? "Click a recognisable spot on the scan."
        : ref.open
          ? "Add GCP, click a spot on the scan, then the same spot on the map."
          : "Open the reference map to pair each scan point with its real-world position.";

    // rebuild the rows only when points were added/removed, so typing isn't interrupted
    const lk = l.gcps.map((p) => p.id).join();
    if (lk !== listKey) { listKey = lk; buildList(); }
    const { fit, note } = fitLayer(l, g);
    const err = new Map(fit?.residuals.map((r) => [r.id, r.err]));
    const px = fit ? (fit.pixelSize[0] + fit.pixelSize[1]) / 2 : 0;
    l.gcps.forEach((p, i) => {
      const el = $("#gcps").children[i] as HTMLElement;
      el.classList.toggle("pending", p.id === editor.pendingId);
      el.querySelector<HTMLElement>(".px")!.textContent = `px ${p.col.toFixed(0)}, ${p.row.toFixed(0)}`;
      const e = err.get(p.id);
      el.querySelector<HTMLElement>(".err")!.textContent = e === undefined ? "" : `${sig(e / px)} px`;
      const x = el.querySelector<HTMLInputElement>(".x")!;
      const y = el.querySelector<HTMLInputElement>(".y")!;
      if (document.activeElement !== x) x.value = p.x === null ? "" : String(p.x);
      if (document.activeElement !== y) y.value = p.y === null ? "" : String(p.y);
    });

    const have = completeGcps(l).length;
    const need = MIN_GCPS[g.method];
    const n = $("#need");
    n.textContent = `${have} of ${l.gcps.length} points paired — ${have >= need ? "enough" : `need ${need}`} for ${g.method}`;
    n.classList.toggle("ok", have >= need);

    const out = $("#fit");
    if (!fit) {
      out.textContent = note;
      out.className = "note";
      return;
    }
    out.className = "fit";
    const lines = [
      `<b>RMSE ${sig(fit.rmse / px)} px</b> (${sig(fit.rmse)} CRS units, ${fit.n} points)`,
      `pixel size ${sig(fit.pixelSize[0])} × ${sig(fit.pixelSize[1])} · rotation ${fit.rotation.toFixed(2)}°`,
    ];
    if (fit.geo) lines.push(`<span class="mono">x = ${fit.geo[0].toFixed(3)} + ${fit.geo[1].toPrecision(8)}·col + ${fit.geo[2].toPrecision(8)}·row<br>y = ${fit.geo[3].toFixed(3)} + ${fit.geo[4].toPrecision(8)}·col + ${fit.geo[5].toPrecision(8)}·row</span>`);
    if (note) lines.push(note);
    out.innerHTML = lines.map((t) => `<div>${t}</div>`).join("");
  }

  editor.watch(() => sync());
  ref.watchMode(() => sync());

  return () => {
    if (keyNow() !== key) build();
    sync();
  };
}
