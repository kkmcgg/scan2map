export interface ProcParams { median: number; k: number } // median 1 = off, k 0 = off
export interface PaletteEntry { rgb: [number, number, number]; share: number }

export type Method = "poly1" | "poly2" | "poly3" | "tps";
export const MIN_GCPS: Record<Method, number> = { poly1: 3, poly2: 6, poly3: 10, tps: 3 };

/**
 * A control point identity, shared by every scan in the group: many scans, one real-world place.
 * x/y are in the group's GCP CRS (null until known) and apply no matter which scan(s) the point is placed on.
 */
export interface Gcp { id: string; x: number | null; y: number | null }

/** Where one of the group's GCPs sits on this particular scan's pixel grid, (0,0) = top-left corner. */
export interface GcpPlacement { gcpId: string; col: number; row: number }

/** Where one scan sits inside a stitched mosaic image. */
export interface Cell { id: string; x: number; y: number; w: number; h: number }
export interface Mosaic { layerId: string; cols: number; cells: Cell[] }

/**
 * A group shares one processing chain, one CRS/warp method, and one set of GCP identities: each GCP has a
 * single real-world position but can be placed at a different pixel position on each of the group's scans.
 * A collapsed group hides its scans and shows one stitched mosaic layer instead.
 */
export interface Group {
  id: string;
  name: string;
  proc: ProcParams;
  srcSrs: string; // CRS of the GCP x/y
  dstSrs: string; // output CRS
  method: Method;
  mosaic: Mosaic | null;
  gcps: Gcp[]; // control point identities shared by every scan in the group
}

export interface ScanLayer {
  id: string;
  name: string;
  file: File;
  width: number;
  height: number;
  groupId: string;
  order: number; // position in the folder listing, so ungrouping restores name order
  hidden: boolean; // a scan folded into its group's mosaic
  gcpPx: GcpPlacement[]; // this scan's pixel position for each of its group's GCPs it has been placed on
  url: string | null; // original, browser-displayable; null until a TIFF has been decoded
  displayUrl: string | null; // processed preview; null = show the original
  applied: ProcParams | null; // the chain displayUrl was made with
  palette: PaletteEntry[] | null;
}

/**
 * list = layers/groups replaced, groups = membership/names/mosaics changed (id = a new group to name),
 * active/select = selection, image = an image url changed, settings = a group's chain/CRS/method changed (id = group),
 * gcps = a group's control points or a scan's placements of them changed (id = group or layer)
 */
export type Change = "list" | "groups" | "active" | "select" | "image" | "settings" | "gcps";
type Listener = (change: Change, id?: string) => void;

export const shownUrl = (l: ScanLayer) => l.displayUrl ?? l.url;
export const sameProc = (a: ProcParams, b: ProcParams) => a.median === b.median && a.k === b.k;

export interface PlacedGcp { id: string; col: number; row: number; x: number; y: number }
/** this scan's GCPs that are both placed on it and have a known real-world position, ready to fit a transform */
export function placedGcps(l: ScanLayer, g: Group): PlacedGcp[] {
  const at = new Map(g.gcps.map((p) => [p.id, p]));
  const out: PlacedGcp[] = [];
  for (const px of l.gcpPx) {
    const p = at.get(px.gcpId);
    if (p && p.x !== null && p.y !== null) out.push({ id: p.id, col: px.col, row: px.row, x: p.x, y: p.y });
  }
  return out;
}

/** the group's GCPs that at least one of the given layers has placed, in the group's original order */
function usedGcps(layers: ScanLayer[], pool: Gcp[]): Gcp[] {
  const ids = new Set(layers.flatMap((l) => l.gcpPx.map((p) => p.gcpId)));
  return pool.filter((p) => ids.has(p.id)).map((p) => ({ ...p }));
}

export function newGroup(name: string, from?: Group): Group {
  return {
    id: crypto.randomUUID(),
    name,
    proc: from ? { ...from.proc } : { median: 1, k: 0 },
    srcSrs: from?.srcSrs ?? "EPSG:2961",
    dstSrs: from?.dstSrs ?? "EPSG:2961",
    method: from?.method ?? "poly1",
    mosaic: null,
    gcps: [],
  };
}

export class LayerStore {
  layers: ScanLayer[] = []; // every layer (including folded ones), by group then folder order
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

  /** what the list shows and the arrow keys walk: everything not folded into a mosaic */
  get shown() {
    return this.layers.filter((l) => !l.hidden);
  }
  members(groupId: string) {
    return this.shown.filter((l) => l.groupId === groupId);
  }
  isMosaic(l: ScanLayer) {
    return this.groups.some((g) => g.mosaic?.layerId === l.id);
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
    this.activeId = this.shown.find((l) => l.id === activeId)?.id ?? this.shown[0]?.id ?? null;
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
    if (!this.shown.some((l) => l.id === id)) return;
    const was = this.activeId;
    if (mode === "toggle" && this.selected.has(id) && this.selected.size > 1) {
      this.selected.delete(id);
      if (this.activeId === id) this.activeId = [...this.selected].at(-1)!;
    } else if (mode === "toggle") {
      this.selected.add(id);
      this.activeId = id;
    } else if (mode === "range" && this.activeId) {
      const shown = this.shown;
      const a = shown.findIndex((l) => l.id === this.activeId);
      const b = shown.findIndex((l) => l.id === id);
      this.selected = new Set(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((l) => l.id));
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
    const shown = this.shown;
    const i = shown.findIndex((l) => l.id === this.activeId);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + delta))];
    if (next) this.setActive(next.id);
  }

  // ---- groups ----

  /** new group (starts as a copy of the first selected scan's group) holding the selected scans */
  groupSelected() {
    const moving = this.shown.filter((l) => this.selected.has(l.id) && !this.isMosaic(l));
    if (!moving.length) return;
    const src = this.group(moving[0].groupId)!;
    const sources = [...new Set(moving.map((l) => l.groupId))].map((id) => this.group(id)!);
    const g = newGroup(`Group ${++this.groupSeq}`, src);
    g.gcps = usedGcps(moving, sources.flatMap((s) => s.gcps));
    this.groups.splice(this.groups.indexOf(src) + 1, 0, g);
    moving.forEach((l) => (l.groupId = g.id));
    for (const s of sources) s.gcps = usedGcps(this.members(s.id), s.gcps); // drop identities no scan of the source group uses any more
    this.afterRegroup(g.id);
  }

  /** every selected scan gets its own group */
  ungroupSelected() {
    for (const l of this.shown.filter((l) => this.selected.has(l.id) && !this.isMosaic(l))) {
      const src = this.group(l.groupId)!;
      if (this.members(src.id).length === 1) continue;
      const g = newGroup(`Group ${++this.groupSeq}`, src);
      g.gcps = usedGcps([l], src.gcps);
      this.groups.splice(this.groups.indexOf(src) + 1, 0, g);
      l.groupId = g.id;
      src.gcps = usedGcps(this.members(src.id), src.gcps);
    }
    this.afterRegroup();
  }

  private afterRegroup(newGroupId?: string) {
    this.groups = this.groups.filter((g) => this.layers.some((l) => l.groupId === g.id));
    this.regroup();
    this.emit("groups", newGroupId);
  }

  renameGroup(id: string, name: string) {
    const g = this.group(id);
    if (!g || !name.trim()) return;
    g.name = name.trim();
    this.emit("groups");
  }

  // ---- mosaics ----

  /** hide the group's scans behind one stitched layer; their placements move onto it (shifted into mosaic pixels) */
  collapseGroup(groupId: string, mosaic: ScanLayer, cells: Cell[], cols: number) {
    const g = this.group(groupId);
    if (!g || g.mosaic) return;
    const at = new Map(cells.map((c) => [c.id, c]));
    const placed = new Set<string>();
    let order = Infinity;
    for (const l of this.layers) {
      const c = at.get(l.id);
      if (!c) continue;
      for (const p of l.gcpPx) {
        // the same GCP placed on more than one source scan (overlapping coverage): keep the first placement
        if (!placed.has(p.gcpId)) { placed.add(p.gcpId); mosaic.gcpPx.push({ gcpId: p.gcpId, col: p.col + c.x, row: p.row + c.y }); }
      }
      l.gcpPx = [];
      l.hidden = true;
      order = Math.min(order, l.order);
    }
    mosaic.groupId = groupId;
    mosaic.order = order;
    this.layers.push(mosaic);
    g.mosaic = { layerId: mosaic.id, cols, cells };
    this.regroup();
    this.activeId = mosaic.id;
    this.selected = new Set([mosaic.id]);
    this.emit("groups");
  }

  /** drop the mosaic and bring the scans back; placements go back to the scan they fall in */
  expandGroup(groupId: string) {
    const g = this.group(groupId);
    const m = g?.mosaic;
    if (!g || !m) return;
    const ml = this.find(m.layerId);
    if (ml) {
      for (const p of ml.gcpPx) {
        const c = m.cells.find((c) => p.col >= c.x && p.col < c.x + c.w && p.row >= c.y && p.row < c.y + c.h);
        const l = c && this.find(c.id);
        if (!c || !l) continue;
        const col = p.col - c.x;
        const row = p.row - c.y;
        if (col < l.width && row < l.height) l.gcpPx.push({ gcpId: p.gcpId, col, row });
      }
      if (ml.url) URL.revokeObjectURL(ml.url);
      if (ml.displayUrl) URL.revokeObjectURL(ml.displayUrl);
      this.layers = this.layers.filter((l) => l !== ml);
    }
    for (const c of m.cells) {
      const l = this.find(c.id);
      if (l) l.hidden = false;
    }
    g.mosaic = null;
    this.activeId = this.members(groupId)[0]?.id ?? this.shown[0]?.id ?? null;
    this.selected = new Set(this.activeId ? [this.activeId] : []);
    this.emit("groups");
  }

  // ---- shared settings ----

  setProc(groupId: string, patch: Partial<ProcParams>) {
    const g = this.group(groupId);
    if (!g) return;
    Object.assign(g.proc, patch);
    this.emit("settings", groupId);
  }

  setGeoref(groupId: string, patch: Partial<Pick<Group, "srcSrs" | "dstSrs" | "method">>) {
    const g = this.group(groupId);
    if (!g) return;
    Object.assign(g, patch);
    this.emit("settings", groupId);
  }

  // ---- control points (identity shared by the group, placement per scan) ----

  /**
   * Create a new GCP identity in the layer's group, and place it at the SAME pixel position on every
   * (visible) scan in the group — scans are assumed to be roughly registered with each other already, so
   * this is normally a good starting guess. The user drags each scan's copy to its actual position after.
   */
  addGcp(layerId: string, p: { col: number; row: number }) {
    const l = this.find(layerId);
    const g = l && this.group(l.groupId);
    if (!l || !g) return null;
    const id = crypto.randomUUID();
    g.gcps.push({ id, x: null, y: null });
    for (const m of this.members(g.id)) m.gcpPx.push({ gcpId: id, col: p.col, row: p.row });
    this.emit("gcps", layerId);
    return id;
  }

  /** place an existing GCP on this scan, or move it if it's already placed there */
  placeGcp(layerId: string, gcpId: string, col: number, row: number) {
    const l = this.find(layerId);
    if (!l) return;
    const px = l.gcpPx.find((p) => p.gcpId === gcpId);
    if (px) Object.assign(px, { col, row });
    else l.gcpPx.push({ gcpId, col, row });
    this.emit("gcps", layerId);
  }

  /** place a GCP back onto a scan that's missing it, guessing its position from another scan that has it (or the scan's centre) */
  placeGcpDefault(layerId: string, gcpId: string) {
    const l = this.find(layerId);
    if (!l || l.gcpPx.some((p) => p.gcpId === gcpId)) return;
    const like = this.members(l.groupId)
      .flatMap((m) => m.gcpPx)
      .find((p) => p.gcpId === gcpId);
    this.placeGcp(layerId, gcpId, like?.col ?? l.width / 2, like?.row ?? l.height / 2);
  }

  /** remove this GCP from just this scan; the identity (and any placement on other scans) is untouched */
  unplaceGcp(layerId: string, gcpId: string) {
    const l = this.find(layerId);
    if (!l) return;
    l.gcpPx = l.gcpPx.filter((p) => p.gcpId !== gcpId);
    this.emit("gcps", layerId);
  }

  /** set a GCP's shared real-world position, used by every scan that has it placed */
  setGcpPos(groupId: string, id: string, patch: Partial<Pick<Gcp, "x" | "y">>) {
    const p = this.group(groupId)?.gcps.find((p) => p.id === id);
    if (!p) return;
    Object.assign(p, patch);
    this.emit("gcps", groupId);
  }

  /** delete a GCP identity outright: its position and its placement on every scan in the group */
  removeGcp(groupId: string, id: string) {
    const g = this.group(groupId);
    if (!g) return;
    g.gcps = g.gcps.filter((p) => p.id !== id);
    for (const l of this.layers) if (l.groupId === groupId) l.gcpPx = l.gcpPx.filter((p) => p.gcpId !== id);
    this.emit("gcps", groupId);
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
