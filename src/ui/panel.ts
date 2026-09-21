import { sameProc, completeGcps, type Change, type Group, type LayerStore, type ScanLayer } from "../layers/store";
import type { GcpEditor } from "../view/gcpEditor";
import type { RefMap } from "../view/refMap";
import { mountProc } from "./procSection";
import { mountGeoref } from "./georefSection";
import { mountMosaic } from "./mosaicSection";

export function mountPanel(root: HTMLElement, store: LayerStore, editor: GcpEditor, ref: RefMap, onOpen: () => void) {
  root.innerHTML = `
    <header>
      <button id="open">Open folder…</button>
      <span id="status"></span>
    </header>
    <div id="modes" title="What the main area shows">
      <button data-mode="scan">Scan</button><button data-mode="split">Scan + map</button><button data-mode="map">Map view</button>
    </div>
    <div id="tools">
      <button id="group" title="Move the selected scans into a new group, then name it">Group</button>
      <button id="ungroup" title="Give each selected scan its own group">Ungroup</button>
    </div>
    <ul id="list"></ul>
    <div id="lower"><section id="mosaic"></section><section id="proc"></section><section id="georef"></section></div>
    <footer>↑/↓ switch · click a group to select it · Shift/Ctrl-click to multi-select · double-click a group to rename</footer>`;
  const list = root.querySelector<HTMLUListElement>("#list")!;
  const status = root.querySelector<HTMLSpanElement>("#status")!;
  const groupBtn = root.querySelector<HTMLButtonElement>("#group")!;
  const ungroupBtn = root.querySelector<HTMLButtonElement>("#ungroup")!;
  root.querySelector<HTMLButtonElement>("#open")!.onclick = onOpen;
  groupBtn.onclick = () => store.groupSelected();
  ungroupBtn.onclick = () => store.ungroupSelected();
  const setStatus = (t: string) => (status.textContent = t);
  ref.onMessage = setStatus;
  const modeBtns = [...root.querySelectorAll<HTMLButtonElement>("#modes button")];
  const paintModes = () => modeBtns.forEach((b) => b.classList.toggle("on", b.dataset.mode === ref.mode));
  modeBtns.forEach((b) => (b.onclick = () => ref.setMode(b.dataset.mode as "scan" | "split" | "map")));
  ref.watchMode(paintModes);
  paintModes();

  const updateMosaic = mountMosaic(root.querySelector("#mosaic")!, store, setStatus);
  const updateProc = mountProc(root.querySelector("#proc")!, store, setStatus);
  const updateGeoref = mountGeoref(root.querySelector("#georef")!, store, editor, ref);

  const rows = new Map<string, HTMLLIElement>();
  const meta = new Map<string, HTMLSpanElement>();
  const names = new Map<string, HTMLSpanElement>();

  function rename(g: Group) {
    const name = names.get(g.id);
    if (!name) return;
    const input = document.createElement("input");
    input.value = g.name;
    input.onblur = () => store.renameGroup(g.id, input.value);
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") input.blur();
      else if (ev.key === "Escape") { input.onblur = null; name.replaceChildren(g.name); }
    };
    input.onclick = (ev) => ev.stopPropagation();
    name.replaceChildren(input);
    input.focus();
    input.select();
  }

  function header(g: Group): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "group";
    li.innerHTML = `<span class="gname"></span><span class="gmeta"></span><button class="edit" title="Rename group">✎</button>`;
    const name = li.querySelector<HTMLSpanElement>(".gname")!;
    name.textContent = (g.mosaic ? "▦ " : "") + g.name;
    li.title = "Click to select the group";
    li.onclick = () => store.selectGroup(g.id);
    name.ondblclick = (e) => { e.stopPropagation(); rename(g); };
    li.querySelector<HTMLButtonElement>(".edit")!.onclick = (e) => { e.stopPropagation(); rename(g); };
    names.set(g.id, name);
    meta.set(g.id, li.querySelector<HTMLSpanElement>(".gmeta")!);
    return li;
  }

  function row(l: ScanLayer): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "scan";
    li.textContent = l.name;
    li.title = `${l.file.name} — ${l.width}×${l.height}`;
    li.onclick = (e) => store.select(l.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "only");
    rows.set(l.id, li);
    return li;
  }

  function render() {
    rows.clear();
    meta.clear();
    names.clear();
    const items: HTMLElement[] = [];
    for (const g of store.groups) items.push(header(g), ...store.members(g.id).map(row));
    list.replaceChildren(...items);
    refresh();
  }

  function refresh() {
    for (const l of store.shown) {
      const li = rows.get(l.id);
      if (!li) continue;
      const g = store.group(l.groupId)!;
      li.classList.toggle("active", l.id === store.activeId);
      li.classList.toggle("selected", store.selected.has(l.id));
      li.classList.toggle("done", !!l.applied && sameProc(l.applied, g.proc));
      li.classList.toggle("stale", !!l.applied && !sameProc(l.applied, g.proc));
    }
    for (const g of store.groups) {
      const m = meta.get(g.id);
      if (!m) continue;
      const members = store.members(g.id);
      const gcps = members.reduce((n, l) => n + completeGcps(l).length, 0);
      m.textContent = `${g.mosaic ? "mosaic of " + g.mosaic.cells.length : members.length + " scans"} · ${gcps} GCP${gcps === 1 ? "" : "s"}`;
    }
    rows.get(store.activeId ?? "")?.scrollIntoView({ block: "nearest" });
    groupBtn.disabled = ungroupBtn.disabled = store.selected.size === 0;
  }

  store.subscribe((c: Change, id?: string) => {
    if (c === "list" || c === "groups") render();
    else refresh();
    updateMosaic();
    updateProc();
    updateGeoref();
    // a group that was just created starts in rename mode so it gets a proper name
    if (c === "groups" && id) {
      const g = store.group(id);
      if (g) rename(g);
    }
  });

  return { setStatus };
}
