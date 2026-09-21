import * as Comlink from "comlink";
import { tiffToImageData } from "../io/decode";

// TIFF -> displayable PNG off the main thread (kept apart from the opencv worker so it starts instantly)
const api = {
  async tiffToPng(file: File): Promise<Blob> {
    const img = await tiffToImageData(file);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext("2d")!.putImageData(img, 0, 0);
    return c.convertToBlob({ type: "image/png" });
  },
};

export type DecodeApi = typeof api;
Comlink.expose(api);
