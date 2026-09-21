import { fromBlob } from "geotiff";

const RASTER = /\.(png|jpe?g|webp|bmp|gif)$/i;
const TIFF = /\.tiff?$/i;

export const isSupported = (name: string) => RASTER.test(name) || TIFF.test(name);

export interface Decoded { width: number; height: number; url: string }

export async function decode(file: File): Promise<Decoded> {
  if (TIFF.test(file.name)) {
    const img = await tiffToImageData(file);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext("2d")!.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    return { width: img.width, height: img.height, url: URL.createObjectURL(blob) };
  }
  const bmp = await createImageBitmap(file);
  const { width, height } = bmp;
  bmp.close();
  return { width, height, url: URL.createObjectURL(file) };
}

export async function tiffToImageData(file: File): Promise<ImageData> {
  const img = await (await fromBlob(file)).getImage();
  const width = img.getWidth();
  const height = img.getHeight();
  const rgb = (await img.readRGB({ interleave: true })) as unknown as Uint8Array | Uint16Array;
  const shift = rgb instanceof Uint16Array ? 8 : 0;
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
    rgba[k] = rgb[j] >> shift;
    rgba[k + 1] = rgb[j + 1] >> shift;
    rgba[k + 2] = rgb[j + 2] >> shift;
    rgba[k + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}