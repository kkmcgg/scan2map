import { decode, isSupported } from "./decode";
import type { ScanLayer } from "../layers/store";

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

export async function loadLayers(
  files: File[],
  onProgress?: (done: number, n: number, name: string) => void,
  concurrency = 4,
): Promise<ScanLayer[]> {
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out: (ScanLayer | null)[] = new Array(files.length).fill(null);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const file = files[i];
      try {
        const d = await decode(file);
        out[i] = {
          id: crypto.randomUUID(),
          name: file.name.replace(/\.[^.]+$/, ""),
          file,
          ...d,
          displayUrl: d.url,
          visible: true,
          opacity: 1,
          proc: { median: 1, k: 0 },
          palette: null,
        };
      } catch (e) {
        console.warn(`skipped ${file.name}`, e);
      }
      onProgress?.(++done, files.length, file.name);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return out.filter((l): l is ScanLayer => l !== null);
}