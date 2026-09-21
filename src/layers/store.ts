export interface ProcParams { median: number; k: number } // median 1 = off, k 0 = off
export interface PaletteEntry { rgb: [number, number, number]; share: number }

export interface ScanLayer {
  id: string;
  name: string;
  file: File;
  width: number;
  height: number;
  url: string; // original, browser-displayable
  displayUrl: string; // what the viewer shows: original or processed preview
  visible: boolean;
  opacity: number;
  proc: ProcParams;
  palette: PaletteEntry[] | null;
}

/** list = layers replaced, props = visibility/opacity, active = selection, image = display image swapped */
export type Change = "list" | "props" | "active" | "image";
type Listener = (change: Change, id?: string) => void;

export class LayerStore {
  layers: ScanLayer[] = []; // index 0 = top of stack
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

  set(layers: ScanLayer[]) {
    for (const l of this.layers) {
      URL.revokeObjectURL(l.url);
      if (l.displayUrl !== l.url) URL.revokeObjectURL(l.displayUrl);
    }
    this.layers = layers;
    this.activeId = layers[0]?.id ?? null;
    this.emit("list");
  }

  update(id: string, patch: Partial<Pick<ScanLayer, "visible" | "opacity">>) {
    const l = this.find(id);
    if (!l) return;
    Object.assign(l, patch);
    this.emit("props", id);
  }

  solo(id: string) {
    this.layers.forEach((l) => (l.visible = l.id === id));
    this.emit("props");
  }

  setActive(id: string) {
    if (id === this.activeId) return;
    this.activeId = id;
    this.emit("active", id);
  }

  setProc(id: string, patch: Partial<ProcParams>) {
    const l = this.find(id);
    if (l) Object.assign(l.proc, patch);
  }

  /** url = null reverts to the original */
  setDisplay(id: string, url: string | null, palette: PaletteEntry[] | null) {
    const l = this.find(id);
    if (!l) return;
    if (l.displayUrl !== l.url) URL.revokeObjectURL(l.displayUrl);
    l.displayUrl = url ?? l.url;
    l.palette = palette;
    this.emit("image", id);
  }
}