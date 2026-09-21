import { TIFF } from "./decode";
import type { Group, LayerStore, PaletteEntry, ProcParams, ScanLayer } from "../layers/store";
import type OlMap from "ol/Map";

/**
 * Session cache in IndexedDB so a reload skips the folder picker and the (slow) TIFF decode.
 *  files   id -> the source File (the cv worker re-reads it)
 *  base    id -> decoded PNG for TIFF sources (other formats display straight from the file)
 *  display id -> processed preview, when there is one
 *  meta    "session" -> layer order/props, active layer, map view
 */

const STORES = ["files", "base", "display", "meta"] as const;
type StoreName = (typeof STORES)[number];

interface LayerMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  groupId: string;
  order: number;
  applied: ProcParams | null;
  palette: PaletteEntry[] | null;
}
interface ViewMeta { center: [number, number]; resolution: number }
interface Session { layers: LayerMeta[]; groups: Group[]; activeId: string | null; view: ViewMeta | null }

export interface Restored { layers: ScanLayer[]; groups: Group[]; activeId: string | null; view: ViewMeta | null }

let dbP: Promise<IDBDatabase> | null = null;
const openDb = () =>
  (dbP ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("scan2map", 1);
    req.onupgradeneeded = () => STORES.forEach((s) => req.result.createObjectStore(s));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
const get = <T>(os: IDBObjectStore, key: string) =>
  new Promise<T | undefined>((resolve, reject) => {
    const r = os.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

// what is already in the db, so unchanged (large) blobs are never rewritten
const saved: Record<"files" | "base", Set<string>> & { display: Map<string, string> } = {
  files: new Set(),
  base: new Set(),
  display: new Map(), // id -> displayUrl that was written
};

export async function restore(): Promise<Restored | null> {
  if (!("indexedDB" in globalThis)) return null;
  const db = await openDb();
  const tx = db.transaction([...STORES], "readonly");
  const [files, base, display, meta] = STORES.map((s) => tx.objectStore(s));
  const session = await get<Session>(meta, "session");
  if (!session?.layers.length) return null;
  if (!session.groups?.length) { await clearAll(); return null; } // written by an older version

  const layers: ScanLayer[] = [];
  for (const m of session.layers) {
    const file = await get<File>(files, m.id);
    if (!file) continue;
    const baseBlob = await get<Blob>(base, m.id);
    const displayBlob = await get<Blob>(display, m.id);
    // TIFFs without a cached decode stay null and are decoded on demand
    const url = baseBlob ? URL.createObjectURL(baseBlob) : TIFF.test(file.name) ? null : URL.createObjectURL(file);
    const displayUrl = displayBlob ? URL.createObjectURL(displayBlob) : null;
    saved.files.add(m.id);
    if (baseBlob) saved.base.add(m.id);
    if (displayUrl) saved.display.set(m.id, displayUrl);
    layers.push({ ...m, file, url, displayUrl });
  }
  return layers.length ? { layers, groups: session.groups, activeId: session.activeId, view: session.view } : null;
}

async function clearAll() {
  const tx = (await openDb()).transaction([...STORES], "readwrite");
  STORES.forEach((s) => tx.objectStore(s).clear());
  await done(tx);
}

/** null if the object url was revoked in the meantime; the next change re-triggers the save */
async function blobOf(url: string): Promise<Blob | null> {
  try {
    return await (await fetch(url)).blob();
  } catch {
    return null;
  }
}

async function save(store: LayerStore, map: OlMap) {
  const layers = [...store.layers];
  const ids = new Set(layers.map((l) => l.id));

  // blobs are fetched up front: an IndexedDB transaction closes if we await anything else inside it
  const puts: { store: StoreName; id: string; blob: Blob; url?: string }[] = [];
  const dels: { store: StoreName; id: string }[] = [];
  for (const l of layers) {
    if (!saved.files.has(l.id)) puts.push({ store: "files", id: l.id, blob: l.file });
    if (l.url && TIFF.test(l.file.name) && !saved.base.has(l.id)) {
      const blob = await blobOf(l.url);
      if (blob) puts.push({ store: "base", id: l.id, blob });
    }
    if (!l.displayUrl) {
      if (saved.display.has(l.id)) dels.push({ store: "display", id: l.id });
    } else if (saved.display.get(l.id) !== l.displayUrl) {
      const blob = await blobOf(l.displayUrl);
      if (blob) puts.push({ store: "display", id: l.id, blob, url: l.displayUrl });
    }
  }
  for (const id of new Set([...saved.files, ...saved.base, ...saved.display.keys()])) {
    if (!ids.has(id)) dels.push({ store: "files", id }, { store: "base", id }, { store: "display", id });
  }

  const v = map.getView();
  const c = v.getCenter();
  const res = v.getResolution();
  const session: Session = {
    layers: layers.map(({ id, name, width, height, groupId, order, applied, palette }) => ({
      id, name, width, height, groupId, order, applied: applied && { ...applied }, palette,
    })),
    groups: structuredClone(store.groups),
    activeId: store.activeId,
    view: c && res ? { center: [c[0], c[1]], resolution: res } : null,
  };

  const db = await openDb();
  const tx = db.transaction([...STORES], "readwrite");
  for (const p of puts) tx.objectStore(p.store).put(p.blob, p.id);
  for (const d of dels) tx.objectStore(d.store).delete(d.id);
  tx.objectStore("meta").put(session, "session");
  await done(tx);

  for (const d of dels) saved[d.store as "files" | "base" | "display"]?.delete(d.id);
  for (const p of puts) {
    if (p.store === "display") saved.display.set(p.id, p.url!);
    else if (p.store !== "meta") saved[p.store].add(p.id);
  }
}

/** Save (debounced) whenever layers or the map view change. Call after restore(). */
export function autosave(store: LayerStore, map: OlMap, onError?: (e: unknown) => void) {
  if (!("indexedDB" in globalThis)) return;
  let timer: number | undefined;
  let chain: Promise<void> = Promise.resolve();
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      chain = chain.then(() => save(store, map)).catch((e) => { console.warn("session save failed", e); onError?.(e); });
    }, 400);
  };
  store.subscribe(schedule);
  map.on("moveend", schedule);
  navigator.storage?.persist?.(); // ask the browser not to evict the cache
}
