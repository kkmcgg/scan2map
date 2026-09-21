import proj4 from "proj4";

/** The reference basemap is web mercator; GCP coordinates are converted to and from it. */
const REF = "EPSG:3857";

const norm = (code: string) => code.trim();
const isDef = (code: string) => code.startsWith("+");

/** UTM zones have a closed-form definition; everything else is looked up online once and cached. */
function builtin(code: string): string | null {
  let m = /^EPSG:(326|327)(\d\d)$/i.exec(code);
  if (m) return `+proj=utm +zone=${+m[2]}${m[1] === "327" ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  m = /^EPSG:269(\d\d)$/i.exec(code);
  if (m) return `+proj=utm +zone=${+m[1]} +datum=NAD83 +units=m +no_defs`;
  return null;
}

const cacheKey = (code: string) => `s2m.crs.${code.toUpperCase()}`;
const lookups = new Map<string, Promise<boolean>>();

export function crsKnown(code: string): boolean {
  code = norm(code);
  if (!code) return false;
  if (isDef(code)) return true;
  if (proj4.defs(code)) return true;
  const def = builtin(code) ?? safeGet(cacheKey(code));
  if (def) { proj4.defs(code, def); return true; }
  return false;
}

function safeGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}

/** Resolve an EPSG code we don't ship a definition for. True once it can be used. */
export function resolveCrs(code: string): Promise<boolean> {
  code = norm(code);
  if (crsKnown(code)) return Promise.resolve(true);
  const n = /^EPSG:(\d+)$/i.exec(code)?.[1];
  if (!n) return Promise.resolve(false);
  let p = lookups.get(code);
  if (!p) {
    p = (async () => {
      for (const url of [`https://epsg.io/${n}.proj4`, `https://spatialreference.org/ref/epsg/${n}/proj4/`]) {
        try {
          const text = (await (await fetch(url)).text()).trim();
          if (!text.startsWith("+proj")) continue;
          proj4.defs(code, text);
          try { localStorage.setItem(cacheKey(code), text); } catch { /* cache is optional */ }
          return true;
        } catch { /* try the next source */ }
      }
      return false;
    })().finally(() => setTimeout(() => lookups.delete(code), 30_000)); // allow a retry later
    lookups.set(code, p);
  }
  return p;
}

/** CRS coordinates -> basemap (EPSG:3857). Null if the CRS isn't known. */
export function toRef(code: string, x: number, y: number): [number, number] | null {
  code = norm(code);
  if (!crsKnown(code)) return null;
  try {
    const r = proj4(code, REF, [x, y]);
    return Number.isFinite(r[0]) && Number.isFinite(r[1]) ? [r[0], r[1]] : null;
  } catch { return null; }
}

/** basemap (EPSG:3857) -> CRS coordinates. Null if the CRS isn't known. */
export function fromRef(code: string, X: number, Y: number): [number, number] | null {
  code = norm(code);
  if (!crsKnown(code)) return null;
  try {
    const r = proj4(REF, code, [X, Y]);
    return Number.isFinite(r[0]) && Number.isFinite(r[1]) ? [r[0], r[1]] : null;
  } catch { return null; }
}
