import { readDims, isSupported, TIFF } from "./decode";
import { decodeWorker } from "../workers";
import { newGroup, type Group, type LayerStore, type ScanLayer } from "../layers/store";

export async function pickFiles(): Promise<File[]> {
  if (window.showDirectoryPicker) {
    const dir = await window.showDirectoryPicker({ mode: "read", id: "scan2map" });
    const files: File[] = [];
    for await (const h of dir.values()) {
      if (h.kind === "file" && isSupported(h.name)) files.push(await (h as FileSystemFileHandle).getFile());
    }
    return files;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])].filter((f) => isSupported(f.name)));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Reads sizes only; TIFFs are decoded later, on demand (see ensureImage). All scans start in one group. */
export async function loadLayers(
  files: File[],
  onProgress?: (done: number, n: number, name: string) => void,
  concurrency = 4,
): Promise<{ layers: ScanLayer[]; groups: Group[] }> {
  const group = newGroup("Group 1");
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out: (ScanLayer | null)[] = new Array(files.length).fill(null);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const file = files[i];
      try {
        const { width, height } = await readDims(file);
        out[i] = {
          id: crypto.randomUUID(),
          name: file.name.replace(/\.[^.]+$/, ""),
          file,
          width,
          height,
          groupId: group.id,
          order: i,
          hidden: false,
          gcps: [],
          url: TIFF.test(file.name) ? null : URL.createObjectURL(file),
          displayUrl: null,
          applied: null,
          palette: null,
        };
      } catch (e) {
        console.warn(`skipped ${file.name}`, e);
      }
      onProgress?.(++done, files.length, file.name);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return { layers: out.filter((l): l is ScanLayer => l !== null), groups: [group] };
}

const pending = new Map<string, Promise<void>>();

/** Make sure the layer's original has a displayable url, decoding TIFFs in a worker (once). */
export function ensureImage(store: LayerStore, l: ScanLayer): Promise<void> {
  if (l.url) return Promise.resolve();
  let p = pending.get(l.id);
  if (!p) {
    p = decodeWorker()
      .tiffToPng(l.file)
      .then((blob) => void store.setUrl(l.id, URL.createObjectURL(blob)))
      .catch((e) => console.error(`couldn't decode ${l.file.name}`, e))
      .finally(() => pending.delete(l.id));
    pending.set(l.id, p);
  }
  return p;
}
