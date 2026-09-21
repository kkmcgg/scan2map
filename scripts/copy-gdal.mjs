import { cpSync, mkdirSync, readdirSync, existsSync } from "node:fs";
const src = "node_modules/gdal3.js/dist/package";
const dst = "public/gdal";
if (!existsSync(src)) { console.error(`copy-gdal: ${src} not found — is gdal3.js installed?`); process.exit(1); }
mkdirSync(dst, { recursive: true });
const files = readdirSync(src).filter((f) => /\.(wasm|data)$/.test(f));
if (!files.length) { console.error(`copy-gdal: no .wasm/.data in ${src}:`, readdirSync(src)); process.exit(1); }
for (const f of files) cpSync(`${src}/${f}`, `${dst}/${f}`);
console.log("copy-gdal:", files.join(", "));