import * as Comlink from "comlink";
import type { CvApi } from "./cv.worker";
import type { GdalApi } from "./gdal.worker";
import type { DecodeApi } from "./decode.worker";

let cv: Comlink.Remote<CvApi> | null = null;
let gdal: Comlink.Remote<GdalApi> | null = null;
let decode: Comlink.Remote<DecodeApi> | null = null;

export const cvWorker = () =>
  (cv ??= Comlink.wrap<CvApi>(new Worker(new URL("./cv.worker.ts", import.meta.url), { type: "module", name: "opencv" })));

export const gdalWorker = () =>
  (gdal ??= Comlink.wrap<GdalApi>(new Worker(new URL("./gdal.worker.ts", import.meta.url), { type: "module", name: "gdal" })));

export const decodeWorker = () =>
  (decode ??= Comlink.wrap<DecodeApi>(new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module", name: "decode" })));

export const cvWorkerIfStarted = () => cv;
