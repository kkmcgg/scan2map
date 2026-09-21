import * as Comlink from "comlink";
import { tiffToImageData, TIFF } from "../io/decode";

// image decoding kept off the main thread, in a worker of its own so it starts instantly
const api = {
  /** TIFF -> displayable PNG */
  async tiffToPng(file: File): Promise<Blob> {
    const img = await tiffToImageData(file);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext("2d")!.putImageData(img, 0, 0);
    return c.convertToBlob({ type: "image/png" });
  },

  /** draw each scan at its (x, y) on a white canvas and return it as a PNG (one scan in memory at a time) */
  async stitch(items: { file: File; x: number; y: number }[], width: number, height: number): Promise<Blob> {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    for (const { file, x, y } of items) {
      if (TIFF.test(file.name)) {
        ctx.putImageData(await tiffToImageData(file), x, y);
      } else {
        const bmp = await createImageBitmap(file);
        ctx.drawImage(bmp, x, y);
        bmp.close();
      }
    }
    return c.convertToBlob({ type: "image/png" });
  },
};

export type DecodeApi = typeof api;
Comlink.expose(api);
