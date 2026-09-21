import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  optimizeDeps: { include: ["@techstark/opencv-js", "gdal3.js", "comlink"] },
});