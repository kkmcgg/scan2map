import * as Comlink from "comlink";
import cvImport from "@techstark/opencv-js";
import { tiffToImageData } from "../io/decode";
import type { ProcParams, PaletteEntry } from "../layers/store";

let cvP: Promise<any> | null = null;
const getCv = () => (cvP ??= initCv());

async function initCv(): Promise<any> {
  const m: any = cvImport;
  if (m instanceof Promise) return await m;
  if (m.Mat) return m;
  await new Promise<void>((r) => (m.onRuntimeInitialized = () => r()));
  return m;
}

const cache = new Map<string, ImageData>();

async function rgba(id: string, file: File): Promise<ImageData> {
  let img = cache.get(id);
  if (!img) {
    img = /\.tiff?$/i.test(file.name) ? await tiffToImageData(file) : await bitmapToImageData(file);
    cache.set(id, img);
  }
  return img;
}

async function bitmapToImageData(file: File): Promise<ImageData> {
  const bmp = await createImageBitmap(file);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** k-means in Lab on a pixel sample, then snap every pixel to its nearest centre (in place). */
function quantize(cv: any, rgb: any, k: number): PaletteEntry[] {
  const lab = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  const L = lab.data as Uint8Array;
  const n = rgb.rows * rgb.cols;

  const S = Math.min(n, 60000);
  const samples = new cv.Mat(S, 3, cv.CV_32F);
  const sd = samples.data32F as Float32Array;
  for (let i = 0; i < S; i++) {
    const p = ((Math.random() * n) | 0) * 3;
    sd[i * 3] = L[p];
    sd[i * 3 + 1] = L[p + 1];
    sd[i * 3 + 2] = L[p + 2];
  }

  const labels = new cv.Mat();
  const centers = new cv.Mat();
  const crit = new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_MAX_ITER, 20, 0.5);
  cv.kmeans(samples, k, labels, crit, 3, cv.KMEANS_PP_CENTERS, centers);
  const C = centers.data32F as Float32Array;

  // centre colours back to RGB
  const cl = new cv.Mat(k, 1, cv.CV_8UC3);
  for (let i = 0; i < k * 3; i++) cl.data[i] = Math.round(C[i]);
  const cr = new cv.Mat();
  cv.cvtColor(cl, cr, cv.COLOR_Lab2RGB);
  const P = cr.data as Uint8Array;

  // assign with a coarse Lab LUT so big scans stay fast
  const lut = new Int16Array(1 << 18).fill(-1);
  const counts = new Uint32Array(k);
  const R = rgb.data as Uint8Array;
  for (let p = 0; p < n * 3; p += 3) {
    const key = ((L[p] >> 2) << 12) | ((L[p + 1] >> 2) << 6) | (L[p + 2] >> 2);
    let best = lut[key];
    if (best < 0) {
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dl = L[p] - C[j * 3], da = L[p + 1] - C[j * 3 + 1], db = L[p + 2] - C[j * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = j; }
      }
      lut[key] = best;
    }
    counts[best]++;
    R[p] = P[best * 3];
    R[p + 1] = P[best * 3 + 1];
    R[p + 2] = P[best * 3 + 2];
  }

  [lab, samples, labels, centers, cl, cr].forEach((m) => m.delete());
  return Array.from({ length: k }, (_, j) => ({
    rgb: [P[j * 3], P[j * 3 + 1], P[j * 3 + 2]] as [number, number, number],
    share: counts[j] / n,
  })).sort((a, b) => b.share - a.share);
}

const api = {
  async process(id: string, file: File, p: ProcParams) {
    const t0 = performance.now();
    const cv = await getCv();
    const img = await rgba(id, file);

    const src = cv.matFromImageData(img);
    let rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    src.delete();

    if (p.median >= 3) {
      const m = new cv.Mat();
      cv.medianBlur(rgb, m, p.median | 1);
      rgb.delete();
      rgb = m;
    }

    const palette = p.k >= 2 ? quantize(cv, rgb, p.k) : [];

    const out = new ImageData(img.width, img.height);
    const s = rgb.data as Uint8Array;
    const d = out.data;
    for (let i = 0, j = 0; i < s.length; i += 3, j += 4) {
      d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2]; d[j + 3] = 255;
    }
    rgb.delete();

    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext("2d")!.putImageData(out, 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    return { blob, palette, ms: Math.round(performance.now() - t0) };
  },

  clear() {
    cache.clear();
  },
};

export type CvApi = typeof api;
Comlink.expose(api);