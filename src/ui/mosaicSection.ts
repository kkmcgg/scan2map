import type { LayerStore, ScanLayer } from "../layers/store";
import { layout, tooBig } from "../io/mosaic";
import { decodeWorker } from "../workers";

/** Collapse a group's scans into one stitched mosaic layer (one GCP set), or expand it back. */
export function mountMosaic(root: HTMLElement, store: LayerStore, setStatus: (t: string) => void) {
  const cols = new Map<string, number>(); // remembered per group
  let busy = false;

  async function collapse(groupId: string, c: number) {
    const g = store.group(groupId);
    const members = store.members(groupId);
    if (!g || members.length < 2 || busy) return;
    const lay = layout(members, c);
    const big = tooBig(lay.width, lay.height);
    if (big) return setStatus(big);

    busy = true;
    render();
    setStatus(`stitching ${members.length} scans…`);
    try {
      const at = new Map(lay.cells.map((cell) => [cell.id, cell]));
      const blob = await decodeWorker().stitch(
        members.map((m) => ({ file: m.file, x: at.get(m.id)!.x, y: at.get(m.id)!.y })),
        lay.width,
        lay.height,
      );
      const file = new File([blob], `${g.name} mosaic.png`, { type: "image/png" });
      const mosaic: ScanLayer = {
        id: crypto.randomUUID(),
        name: `${g.name} mosaic`,
        file,
        width: lay.width,
        height: lay.height,
        groupId,
        order: 0,
        hidden: false,
        gcps: [],
        url: URL.createObjectURL(file),
        displayUrl: null,
        applied: null,
        palette: null,
      };
      store.collapseGroup(groupId, mosaic, lay.cells, Math.min(c, members.length));
      setStatus(`${g.name}: ${members.length} scans → ${lay.width}×${lay.height} mosaic`);
    } catch (e) {
      console.error(e);
      setStatus("stitching failed — see console");
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    const g = store.activeGroup;
    if (!g) { root.replaceChildren(); return; }
    const m = g.mosaic;
    const members = store.members(g.id);

    if (m) {
      const ml = store.layers.find((l) => l.id === m.layerId);
      root.innerHTML = `
        <h3></h3>
        <div class="note">Collapsed: ${m.cells.length} scans stitched into ${ml ? `${ml.width}×${ml.height} px` : "one image"}, with a single GCP set. Expanding gives points back to the scans they fall in.</div>
        <div class="buttons"><button id="expand">Expand to scans</button></div>`;
      root.querySelector("h3")!.textContent = `Mosaic — ${g.name}`;
      root.querySelector<HTMLButtonElement>("#expand")!.onclick = () => store.expandGroup(g.id);
      return;
    }
    if (members.length < 2) { root.replaceChildren(); return; }

    const c = Math.min(cols.get(g.id) ?? Math.ceil(Math.sqrt(members.length)), members.length);
    root.innerHTML = `
      <h3></h3>
      <label>Columns <input id="cols" type="number" min="1" max="${members.length}" step="1" value="${c}"></label>
      <div id="size" class="note"></div>
      <div class="buttons"><button id="collapse">Collapse to mosaic</button></div>`;
    root.querySelector("h3")!.textContent = `Mosaic — ${g.name}`;
    const input = root.querySelector<HTMLInputElement>("#cols")!;
    const size = root.querySelector<HTMLElement>("#size")!;
    const btn = root.querySelector<HTMLButtonElement>("#collapse")!;
    const paint = () => {
      const n = Math.max(1, Math.min(members.length, Math.round(+input.value) || 1));
      cols.set(g.id, n);
      const lay = layout(members, n);
      const big = tooBig(lay.width, lay.height);
      size.textContent = big ?? `${n} × ${Math.ceil(members.length / n)} tiles → ${lay.width}×${lay.height} px, in list order, left to right`;
      btn.disabled = busy || !!big;
    };
    input.oninput = paint;
    btn.onclick = () => collapse(g.id, cols.get(g.id) ?? c);
    paint();
  }

  let key = "";
  return () => {
    // rebuild when the group or its shape changes, not on every keystroke elsewhere
    const g = store.activeGroup;
    const k = g ? `${g.id}|${g.name}|${g.mosaic?.layerId ?? ""}|${store.members(g.id).length}` : "";
    if (k !== key) { key = k; render(); }
  };
}
