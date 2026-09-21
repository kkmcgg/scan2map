export interface ProcParams { median: number; k: number } // median 1 = off, k 0 = off
export interface PaletteEntry { rgb: [number, number, number]; share: number }

export interface ScanLayer {
  id: string;
  name: string;
  file: File;
  width: number;
  height: number;
  url: string | null; // original, browser-displayable; null until a TIFF has been decoded
  displayUrl: string | null; // processed preview; null = show the original
  proc: ProcParams;
  palette: PaletteEntry[] | null;
}

/** list = layers replaced, active = selection, image = an image url changed */
export type Change = "list" | "active" | "image";
type Listener = (change: Change, id?: string) => void;

export const shownUrl = (l: ScanLayer) => l.displayUrl ?? l.url;

export class LayerStore {
  layers: ScanLayer[] = [];
  activeId: string | null = null;
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

  get active() {
    return this.activeId ? this.find(this.activeId) ?? null : null;
  }

  set(layers: ScanLayer[], activeId?: string | null) {
    for (const l of this.layers) {
      if (l.url) URL.revokeObjectURL(l.url);
      if (l.displayUrl) URL.revokeObjectURL(l.displayUrl);
    }
    this.layers = layers;
    this.activeId = layers.find((l) => l.id === activeId)?.id ?? layers[0]?.id ?? null;
    this.emit("list");
  }

  setActive(id: string) {
    if (id === this.activeId || !this.find(id)) return;
    this.activeId = id;
    this.emit("active", id);
  }

  /** move the selection by delta rows, stopping at the ends */
  step(delta: number) {
    const i = this.layers.findIndex((l) => l.id === this.activeId);
    const next = this.layers[Math.min(this.layers.length - 1, Math.max(0, i + delta))];
    if (next) this.setActive(next.id);
  }

  setProc(id: string, patch: Partial<ProcParams>) {
    const l = this.find(id);
    if (l) Object.assign(l.proc, patch);
  }

  /** attach the decoded original; false (and the url is revoked) if the layer is gone */
  setUrl(id: string, url: string) {
    const l = this.find(id);
    if (!l || l.url) { URL.revokeObjectURL(url); return false; }
    l.url = url;
    this.emit("image", id);
    return true;
  }

  /** url = null reverts to the original */
  setDisplay(id: string, url: string | null, palette: PaletteEntry[] | null) {
    const l = this.find(id);
    if (!l) return;
    if (l.displayUrl) URL.revokeObjectURL(l.displayUrl);
    l.displayUrl = url;
    l.palette = palette;
    this.emit("image", id);
  }
}
