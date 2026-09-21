import * as Comlink from "comlink";
import initGdalJs from "gdal3.js";
import { MIN_GCPS } from "../layers/store";

// gdal3.js installs its own worker message handler when loaded in a worker; we talk via Comlink instead
self.onmessage = null;

let gdalP: Promise<any> | null = null;
const getGdal = () =>
  (gdalP ??= (initGdalJs as any)({
    paths: { wasm: "/gdal/gdal3WebAssembly.wasm", data: "/gdal/gdal3WebAssembly.data" },
    useWorker: false,
  }));

/** col/row are GDAL pixel/line: continuous, (0,0) = top-left corner of the scan */
export interface Gcp { col: number; row: number; x: number; y: number }

export interface WarpOptions {
  srcSrs: string; // CRS of the GCP x/y, e.g. "EPSG:2961"
  dstSrs: string; // output CRS
  method: "poly1" | "poly2" | "poly3" | "tps";
  extent?: [number, number, number, number]; // xmin ymin xmax ymax in dstSrs
  res?: number; // cell size in dstSrs units
  resampling: "near" | "bilinear";
  nodata: number;
}


// raw float32 + ENVI header is the simplest reliable way to hand GDAL a typed array
const enviHeader = (w: number, h: number) =>
  ["ENVI", `samples = ${w}`, `lines = ${h}`, "bands = 1", "header offset = 0",
   "data type = 4", "interleave = bsq", "byte order = 0"].join("\n");

const api = {
  async info() {
    const g = await getGdal();
    return {
      raster: Object.keys(g.drivers.raster).length,
      vector: Object.keys(g.drivers.vector).length,
    };
  },

  /** Float32 scan-space grid + GCPs → georeferenced Float32 GeoTIFF bytes */
  async warp(values: Float32Array, width: number, height: number, gcps: Gcp[], o: WarpOptions) {
    if (gcps.length < MIN_GCPS[o.method]) throw new Error(`${o.method} needs ≥ ${MIN_GCPS[o.method]} GCPs`);
    const g = await getGdal();
    const nd = String(o.nodata);

    const opened = await g.open([
      new File([values as BlobPart], "grid.bin"),
      new File([enviHeader(width, height)], "grid.hdr"),
    ]);
    const src = opened.datasets[0];
    if (!src) throw new Error(`GDAL open failed: ${JSON.stringify(opened.errors)}`);

    const gcpArgs = gcps.flatMap((p) => ["-gcp", p.col, p.row, p.x, p.y].map(String));
    const tagged = await g.gdal_translate(src, ["-of", "GTiff", "-a_srs", o.srcSrs, "-a_nodata", nd, ...gcpArgs]);
    const taggedDs = (await g.open(new File([await g.getFileBytes(tagged)], "gcp.tif"))).datasets[0];

    const args = [
      "-of", "GTiff", "-ot", "Float32",
      "-t_srs", o.dstSrs, "-r", o.resampling,
      "-srcnodata", nd, "-dstnodata", nd,
      "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3",
      ...(o.method === "tps" ? ["-tps"] : ["-order", o.method.slice(4)]),
    ];
    if (o.extent) args.push("-te", ...o.extent.map(String));
    if (o.res) args.push("-tr", String(o.res), String(o.res));

    const out = await g.gdalwarp(taggedDs, args);
    const bytes: Uint8Array = await g.getFileBytes(out);
    g.close(src);
    g.close(taggedDs);
    return Comlink.transfer(bytes, [bytes.buffer]);
  },
};

export type GdalApi = typeof api;
Comlink.expose(api);