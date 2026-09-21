import { sameProc, completeGcps, type Change, type Group, type LayerStore, type ScanLayer } from "../layers/store";
import type { GcpEditor } from "../view/gcpEditor";
import { mountProc } from "./procSection";
import { mountGeoref } from "./georefSection";

export function mountPanel(root: HTMLElement, store: LayerStore, editor: GcpEditor, onOpen: () => void) {
  root.innerHTML = `
    <header>
      <button id="open">Open folder…</button>
      <span id="status"></span>
    </header>
    <div id="tools">
      <button id="group" title="Move the selected scans into a new group">Group</button>
      <button id="ungroup" title="Give each selected scan its own group">Ungroup</button>
    </div>
    <ul id="list"></ul>
    <div id="lower"><section id="proc"></section><section id="georef"></section></div>
    <footer>↑/↓ switch · click a group to select it · Shift/Ctrl-click to multi-select</footer>`;
  const list = root.querySelector<HTMLUListElement>("#list")!;
  const status = root.querySelector<HTMLSpanElement>("#status")!;
  const groupBtn = root.querySelector<HTMLButtonElement>("#group")!;
  const ungroupBtn = root.querySelector<HTMLButtonElement>("#ungroup")!;
  root.querySelector<HTMLButtonElement>("#open")!.onclick = onOpen;
  groupBtn.onclick = () => store.groupSelected();
  ungroupBtn.onclick = () => store.ungroupSelected();
  const setStatus = (t: string) => (status.textContent = t);

  const updateProc = mountProc(root.querySelector("#proc")!, store, setStatus);
  const updateGeoref = mountGeoref(root.querySelector("#georef")!, store, editor);

  const rows = new Map<string, HTMLLIElement>();
  const meta = new Map<string, HTMLSpanElement>();

  function header(g: Group): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "group";
    li.innerHTML = `<span class="gname"></span><span class="gmeta"></span>`;
    const name = li.querySelector<HTMLSpanElement>(".gname")!;
    name.textContent = g.name;
    name.title = "Click to select the group, double-click to rename";
    li.onclick = () => store.selectGroup(g.id);
    name.ondblclick = (e) => {
      e.stopPropagation();
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
      input.select();
    };
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
    const items: HTMLElement[] = [];
    for (const g of store.groups) items.push(header(g), ...store.members(g.id).map(row));
    list.replaceChildren(...items);
    refresh();
  }

  function refresh() {
    for (const l of store.layers) {
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
      const gcps = completeGcps(g).length;
      m.textContent = `${store.members(g.id).length} scans · ${gcps} GCP${gcps === 1 ? "" : "s"}`;
    }
    rows.get(store.activeId ?? "")?.scrollIntoView({ block: "nearest" });
    groupBtn.disabled = ungroupBtn.disabled = store.selected.size === 0;
  }

  store.subscribe((c: Change) => {
    if (c === "list" || c === "groups") render();
    else refresh();
    updateProc();
    updateGeoref();
  });

  return { setStatus };
}
