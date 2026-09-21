export interface ProcParams { median: number; k: number } // median 1 = off, k 0 = off
export interface PaletteEntry { rgb: [number, number, number]; share: number }

export type Method = "poly1" | "poly2" | "poly3" | "tps";
export const MIN_GCPS: Record<Method, number> = { poly1: 3, poly2: 6, poly3: 10, tps: 3 };

/** col/row are pixel/line in the scan, (0,0) = top-left corner; x/y are in the group's GCP CRS (null until typed) */
export interface Gcp { id: string; col: number; row: number; x: number | null; y: number | null }
export interface Georef { srcSrs: string; dstSrs: string; method: Method; gcps: Gcp[] }

/** Scans in a group share one processing chain and one georeferencing. */
export interface Group { id: string; name: string; proc: ProcParams; georef: Georef }

export interface ScanLayer {
  id: string;
  name: string;
  file: File;
  width: number;
  height: number;
  groupId: string;
  order: number; // position in the folder listing, so ungrouping restores name order
  url: string | null; // original, browser-displayable; null until a TIFF has been decoded
  displayUrl: string | null; // processed preview; null = show the original
  applied: ProcParams | null; // the chain displayUrl was made with
  palette: PaletteEntry[] | null;
}

/**
 * list = layers/groups replaced, groups = membership or names changed, active/select = selection,
 * image = an image url changed, settings = a group's chain or georef changed (id = group)
 */
export type Change = "list" | "groups" | "active" | "select" | "image" | "settings";
type Listener = (change: Change, id?: string) => void;

export const shownUrl = (l: ScanLayer) => l.displayUrl ?? l.url;
export const sameProc = (a: ProcParams, b: ProcParams) => a.median === b.median && a.k === b.k;
export const completeGcps = (g: Group) => g.georef.gcps.filter((p) => p.x !== null && p.y !== null);

export function newGroup(name: string, from?: Group): Group {
  return {
    id: crypto.randomUUID(),
    name,
    proc: from ? { ...from.proc } : { median: 1, k: 0 },
    georef: from
      ? { ...from.georef, gcps: from.georef.gcps.map((p) => ({ ...p, id: crypto.randomUUID() })) }
      : { srcSrs: "EPSG:2961", dstSrs: "EPSG:2961", method: "poly1", gcps: [] },
  };
}

export class LayerStore {
  layers: ScanLayer[] = []; // kept in display order: by group, then folder order
  groups: Group[] = [];
  activeId: string | null = null;
  selected = new Set<string>();
  private groupSeq = 0;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(c: Change, id?: string) {
    this.listeners.forEach((fn) => fn(c, id));
  }
  private find(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  group(id: string) {
    return this.groups.find((g) => g.id === id);
  }
  members(groupId: string) {
    return this.layers.filter((l) => l.groupId === groupId);
  }

  get active() {
    return this.activeId ? this.find(this.activeId) ?? null : null;
  }
  get activeGroup() {
    const l = this.active;
    return l ? this.group(l.groupId) ?? null : null;
  }

  set(layers: ScanLayer[], groups: Group[], activeId?: string | null) {
    for (const l of this.layers) {
      if (l.url) URL.revokeObjectURL(l.url);
      if (l.displayUrl) URL.revokeObjectURL(l.displayUrl);
    }
    this.layers = layers;
    this.groups = groups;
    this.groupSeq = groups.length;
    this.regroup();
    this.activeId = this.layers.find((l) => l.id === activeId)?.id ?? this.layers[0]?.id ?? null;
    this.selected = new Set(this.activeId ? [this.activeId] : []);
    this.emit("list");
  }

  private regroup() {
    const at = new Map(this.groups.map((g, i) => [g.id, i]));
    this.layers.sort((a, b) => at.get(a.groupId)! - at.get(b.groupId)! || a.order - b.order);
  }

  // ---- selection ----

  /** only = just this one; toggle = ctrl-click; range = shift-click from the active scan */
  select(id: string, mode: "only" | "toggle" | "range" = "only") {
    if (!this.find(id)) return;
    const was = this.activeId;
    if (mode === "toggle" && this.selected.has(id) && this.selected.size > 1) {
      this.selected.delete(id);
      if (this.activeId === id) this.activeId = [...this.selected].at(-1)!;
    } else if (mode === "toggle") {
      this.selected.add(id);
      this.activeId = id;
    } else if (mode === "range" && this.activeId) {
      const a = this.layers.findIndex((l) => l.id === this.activeId);
      const b = this.layers.findIndex((l) => l.id === id);
      this.selected = new Set(this.layers.slice(Math.min(a, b), Math.max(a, b) + 1).map((l) => l.id));
      this.activeId = id;
    } else {
      this.selected = new Set([id]);
      this.activeId = id;
    }
    if (this.activeId !== was) this.emit("active", this.activeId!);
    this.emit("select");
  }

  setActive(id: string) {
    this.select(id, "only");
  }

  selectGroup(groupId: string) {
    const ids = this.members(groupId).map((l) => l.id);
    if (!ids.length) return;
    const was = this.activeId;
    this.selected = new Set(ids);
    if (!this.activeId || !this.selected.has(this.activeId)) this.activeId = ids[0];
    if (this.activeId !== was) this.emit("active", this.activeId);
    this.emit("select");
  }

  /** move the selection by delta rows, stopping at the ends */
  step(delta: number) {
    const i = this.layers.findIndex((l) => l.id === this.activeId);
    const next = this.layers[Math.min(this.layers.length - 1, Math.max(0, i + delta))];
    if (next) this.setActive(next.id);
  }

  // ---- groups ----

  /** new group (starts as a copy of the first selected scan's group) holding the selected scans */
  groupSelected() {
    const moving = this.layers.filter((l) => this.selected.has(l.id));
    if (!moving.length) return;
    const src = this.group(moving[0].groupId)!;
    const g = newGroup(`Group ${++this.groupSeq}`, src);
    this.groups.splice(this.groups.indexOf(src) + 1, 0, g);
    moving.forEach((l) => (l.groupId = g.id));
    this.afterRegroup();
  }

  /** every selected scan gets its own group */
  ungroupSelected() {
    for (const l of this.layers.filter((l) => this.selected.has(l.id))) {
      const src = this.group(l.groupId)!;
      if (this.members(src.id).length === 1) continue;
      const g = newGroup(`Group ${++this.groupSeq}`, src);
      this.groups.splice(this.groups.indexOf(src) + 1, 0, g);
      l.groupId = g.id;
    }
    this.afterRegroup();
  }

  private afterRegroup() {
    this.groups = this.groups.filter((g) => this.layers.some((l) => l.groupId === g.id));
    this.regroup();
    this.emit("groups");
  }

  renameGroup(id: string, name: string) {
    const g = this.group(id);
    if (!g || !name.trim()) return;
    g.name = name.trim();
    this.emit("groups");
  }

  // ---- shared settings ----

  setProc(groupId: string, patch: Partial<ProcParams>) {
    const g = this.group(groupId);
    if (!g) return;
    Object.assign(g.proc, patch);
    this.emit("settings", groupId);
  }

  setGeoref(groupId: string, patch: Partial<Pick<Georef, "srcSrs" | "dstSrs" | "method">>) {
    const g = this.group(groupId);
    if (!g) return;
    Object.assign(g.georef, patch);
    this.emit("settings", groupId);
  }

  addGcp(groupId: string, p: { col: number; row: number }) {
    const g = this.group(groupId);
    if (!g) return;
    g.georef.gcps.push({ id: crypto.randomUUID(), col: p.col, row: p.row, x: null, y: null });
    this.emit("settings", groupId);
  }

  updateGcp(groupId: string, id: string, patch: Partial<Omit<Gcp, "id">>) {
    const p = this.group(groupId)?.georef.gcps.find((p) => p.id === id);
    if (!p) return;
    Object.assign(p, patch);
    this.emit("settings", groupId);
  }

  removeGcp(groupId: string, id: string) {
    const g = this.group(groupId);
    if (!g) return;
    g.georef.gcps = g.georef.gcps.filter((p) => p.id !== id);
    this.emit("settings", groupId);
  }

  // ---- images ----

  /** attach the decoded original; false (and the url is revoked) if the layer is gone */
  setUrl(id: string, url: string) {
    const l = this.find(id);
    if (!l || l.url) { URL.revokeObjectURL(url); return false; }
    l.url = url;
    this.emit("image", id);
    return true;
  }

  /** url = null reverts to the original */
  setDisplay(id: string, url: string | null, palette: PaletteEntry[] | null, applied: ProcParams | null = null) {
    const l = this.find(id);
    if (!l) return;
    if (l.displayUrl) URL.revokeObjectURL(l.displayUrl);
    l.displayUrl = url;
    l.palette = palette;
    l.applied = url ? applied : null;
    this.emit("image", id);
  }
}
