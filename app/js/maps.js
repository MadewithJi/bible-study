// Real maps (spec §9.7 / §9.9, "open-source map" revision): MapLibre GL JS (BSD) with the OpenFreeMap
// vector basemap (positron / dark), AWS Terrain Tiles (Mapzen terrarium) for hillshade and optional 3D,
// the Digital Atlas of the Roman Empire (DARE, CC BY 4.0) as a historical raster layer, and Paul's
// journeys as GeoJSON. One controller shape serves the stage map and the drawer mini map:
//   createMap(host, opts) -> { map, ready, setPins, focus, highlight, fit, setPaul, setLayer, setTerrain,
//                             restyle, rehost, remove }
// Every live instance is registered so detached ones are swept (browsers cap live WebGL contexts).

/** MapLibre's popup close button: an empty drawn cross with a real name (setHTML re-creates it each time). */
function fixClose(pop) {
  const x = pop && pop.getElement && pop.getElement() && pop.getElement().querySelector('.maplibregl-popup-close-button');
  if (x) { x.textContent = ''; x.title = 'Close'; x.setAttribute('aria-label', 'Close popup'); }
}

/** A popup's own content in a box that scrolls (the mini map caps it), so the close button stays put above it. */
const scrollBox = html => `<div class="pop-scroll">${html}</div>`;

export const MAPLIBRE_VERSION = '5.24.0'; // newest cdnjs release that ships the UMD build (6.x has CSS only)
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/${MAPLIBRE_VERSION}/`;
const LIB_JS = { href: CDN + 'maplibre-gl.min.js', sri: 'sha512-hoXlvOdSmh58mppUyZHZsscHkR/yXl6zLpTMTNwA6IZ61DpeaCNjosRu1WJ2DeIpkfW5MsJJ9H89zjV4IBGqRw==' };
const LIB_CSS = { href: CDN + 'maplibre-gl.min.css', sri: 'sha512-KIMsMWIdnoG9OwZa+oaIafmbDonqck1UCmq+/zcUi2aaZ97N9QE6TqpTM+n36EO40HGh64hU/375zxtjx7WTyQ==' };
const STYLE_URL = { light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark' };
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DARE_TILES = 'https://dh.gu.se/tiles/imperium/{z}/{x}/{y}.png';
// The atlas has no tiles for the Sahara band, the far north-east or the open Atlantic edge, and dh.gu.se
// answers those with a 404 that carries no CORS header (a console error per tile). Three boxes cover what
// it has (a z3–z10 scan of the old [-15, 12, 60, 60] box), so no request falls outside the atlas.
/**
 * Paul's journeys by route_id in pauls_journeys.geojson: one colour each, distinct on the night stage and on the dimmed
 * Roman atlas, shared by the map's lines and the stage legend (viz.js).
 */
export const PAUL_ROUTES = [
  { id: 1, name: 'First journey', color: '#1fa99b' },
  { id: 2, name: 'Second journey', color: '#4c9dff' },
  { id: 3, name: 'Third journey', color: '#f0b43c' },
  { id: 4, name: 'Voyage to Rome', color: '#ff6b8b' },
];
const DARE_PARTS = [[-10.1, 24.9, 28.1, 60], [28.1, 24.9, 60, 50.6], [25, 12, 55.1, 24.9]];
const A_ = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
const ATTR = {
  osm: `${A_('https://openfreemap.org', 'OpenFreeMap')} ${A_('https://www.openmaptiles.org/', '© OpenMapTiles')} ${A_('https://www.openstreetmap.org/copyright', '© OpenStreetMap contributors')}`,
  dem: `Terrain: ${A_('https://github.com/tilezen/joerd/blob/master/docs/attribution.md', 'Mapzen, AWS Terrain Tiles')}`,
  dare: `${A_('https://imperium.ahlfeldt.se/', 'Digital Atlas of the Roman Empire')} © Johan Åhlfeldt, Univ. of Gothenburg, ${A_('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')}`,
};
const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------------- place links */
const httpsURL = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : '');
/**
 * Scholarly records for a place, as [url, label] pairs: Pleiades, the Roman atlas (DARE), GeoNames
 * when build.py found them (places[id].links, optional), and a Pleiades search when there is no record.
 */
export function placeLinks(p) {
  const L = (p && p.links) || {}, out = [];
  const pl = httpsURL(L.pleiades), da = httpsURL(L.dare), gn = httpsURL(L.geonames);
  if (pl) out.push([pl, 'Pleiades']);
  if (da) out.push([da, 'Roman atlas (DARE)']);
  if (gn) out.push([gn, 'GeoNames']);
  // A landmark inside a city (prec 'Related-Within': the Angle, the Sheep Gate in Jerusalem) is not an ancient place
  // of its own, so a Pleiades search for its name finds nothing useful.
  if (!pl && p && p.n && p.prec !== 'Related-Within') out.push([`https://pleiades.stoa.org/search?SearchableText=${encodeURIComponent(p.n)}`, 'Search Pleiades']);
  return out;
}

/* ---------------------------------------------------------------- loader */
let glOK = null;
/** WebGL support check (the probe context is released at once). */
export function webglSupported() {
  if (glOK !== null) return glOK;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    glOK = !!gl;
    if (gl) { const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); }
  } catch (e) { glOK = false; }
  return glOK;
}
let libP = null;
/** Loads the pinned MapLibre JS + CSS from cdnjs. Resolves true when usable, false on failure, 8s timeout or no WebGL. */
export function loadMapLibre() {
  if (window.maplibregl && window.maplibregl.Map) return Promise.resolve(webglSupported());
  if (libP) return libP;
  if (!webglSupported()) return Promise.resolve(false);
  libP = new Promise(res => {
    let timer = 0, done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); if (!ok) libP = null; res(ok); };
    if (!document.querySelector('link[data-maplibre]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = LIB_CSS.href; l.integrity = LIB_CSS.sri; l.crossOrigin = 'anonymous'; l.dataset.maplibre = '';
      document.head.appendChild(l);
    }
    let s = document.querySelector('script[data-maplibre]');
    if (!s) {
      s = document.createElement('script');
      s.src = LIB_JS.href; s.integrity = LIB_JS.sri; s.crossOrigin = 'anonymous'; s.async = true; s.dataset.maplibre = '';
      document.head.appendChild(s);
    }
    s.addEventListener('load', () => finish(!!(window.maplibregl && window.maplibregl.Map)));
    s.addEventListener('error', () => { s.remove(); finish(false); });
    timer = setTimeout(() => finish(!!(window.maplibregl && window.maplibregl.Map)), 8000);
  });
  return libP;
}

/* ---------------------------------------------------------------- theme + tokens */
/** 'light' | 'dark' from html[data-theme], else prefers-color-scheme. */
export function resolvedTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
}
/** The effective scheme of a host: the night stage declares color-scheme: dark in both themes. */
export function themeOf(el) {
  try {
    const cs = el && el.isConnected ? getComputedStyle(el).colorScheme || '' : '';
    const d = /\bdark\b/.test(cs), l = /\blight\b/.test(cs);
    if (d && !l) return 'dark';
    if (l && !d) return 'light';
  } catch (e) { /* fall through */ }
  return resolvedTheme();
}
const TOKEN_FALLBACK = {
  light: { land: '#f1eee8', sea: '#dae4ed', water: '#8fb1d1', label: '#1d1d1f', label2: '#646469', label3: '#808085', nt: '#0f9489', surface: '#f5f3ee' },
  dark: { land: '#1c1c1e', sea: '#0f1822', water: '#3c5f82', label: '#f5f5f7', label2: '#a1a1a6', label3: '#86868b', nt: '#1fa99b', surface: '#000000' },
};
function readTokens(el, theme) {
  const F = TOKEN_FALLBACK[theme];
  let cs = null;
  try { cs = el && el.isConnected ? getComputedStyle(el) : null; } catch (e) { cs = null; }
  const t = (n, fb) => (cs && cs.getPropertyValue(n).trim()) || fb;
  return {
    land: t('--map-land', F.land), sea: t('--map-sea', F.sea), water: t('--map-water', F.water),
    label: t('--label', F.label), label2: t('--label-2', F.label2), label3: t('--label-3', F.label3),
    nt: t('--nt', F.nt), surface: t('--stage-surface', '') || t('--bg', F.surface),
  };
}

/* ---------------------------------------------------------------- colour helpers */
function parseColor(s) {
  s = String(s || '').trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(x => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x)));
    if (p.length >= 3 && p.slice(0, 3).every(isFinite)) return [p[0], p[1], p[2], p.length > 3 && isFinite(p[3]) ? (p[3] > 1 ? p[3] / 255 : p[3]) : 1];
  }
  return null;
}
const rgbStr = c => `rgba(${c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(255, v)))).join(',')},${+(c[3] ?? 1).toFixed(3)})`;
/** a + (b - a) * t in sRGB; returns a string MapLibre accepts. */
function mix(a, b, t) {
  const A = parseColor(a), B = parseColor(b);
  if (!A || !B) return A ? rgbStr(A) : String(a);
  return rgbStr(A.map((v, i) => v + (B[i] - v) * t));
}
function alpha(c, a) { const C = parseColor(c); return C ? rgbStr([C[0], C[1], C[2], a]) : String(c); }
/** Scale the numeric outputs of a number / zoom interpolate / zoom step value (other expressions untouched). */
function scaleNum(v, k) {
  if (typeof v === 'number') return +(v * k).toFixed(3);
  if (Array.isArray(v) && v[0] === 'interpolate' && Array.isArray(v[2]) && v[2][0] === 'zoom') return v.map((x, i) => (i >= 4 && i % 2 === 0 && typeof x === 'number' ? +(x * k).toFixed(3) : x));
  if (Array.isArray(v) && v[0] === 'step' && Array.isArray(v[1]) && v[1][0] === 'zoom') return v.map((x, i) => (i >= 2 && i % 2 === 0 && typeof x === 'number' ? +(x * k).toFixed(3) : x));
  return v;
}

/* ---------------------------------------------------------------- style */
const styleCache = {};
function fetchStyle(theme) {
  if (styleCache[theme]) return styleCache[theme];
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ac && ac.abort(), 8000);
  const p = fetch(STYLE_URL[theme], { credentials: 'omit', signal: ac ? ac.signal : undefined })
    .then(r => { if (!r.ok) throw new Error('style ' + r.status); return r.json(); })
    .finally(() => clearTimeout(timer));
  styleCache[theme] = p;
  p.catch(() => { delete styleCache[theme]; });
  return p;
}
const DROP_SOURCE_LAYERS = new Set(['poi', 'housenumber', 'transportation_name', 'aerodrome_label', 'mountain_peak', 'transportation']);
const DROP_LABEL = /^(label_other|label_village|label_state|place_other|place_suburb|place_village|place_state|airport)$/;
// Latin script only: no label rather than a mixed-script one. OpenFreeMap's name_en falls back to the
// native `name`, so a name_en equal to a non-Latin `name` is not English: use name:latin (or nothing).
const LATIN_NAME = ['case',
  ['all', ['has', 'name:nonlatin'], ['==', ['get', 'name_en'], ['get', 'name']]], ['coalesce', ['get', 'name:latin'], ''],
  ['coalesce', ['get', 'name_en'], ['get', 'name:latin'], '']];
const NAMED_LAYERS = new Set(['place', 'water_name']); // basemap labels a pin of the same name replaces

function hillshadePaint(theme) {
  return theme === 'dark'
    ? { 'hillshade-exaggeration': 0.75, 'hillshade-shadow-color': 'rgba(0,0,0,0.95)', 'hillshade-highlight-color': 'rgba(205,218,238,0.26)', 'hillshade-accent-color': 'rgba(0,0,0,0.6)', 'hillshade-illumination-direction': 315, 'hillshade-illumination-anchor': 'viewport' }
    : { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': 'rgba(52,62,82,0.62)', 'hillshade-highlight-color': 'rgba(255,255,255,0.9)', 'hillshade-accent-color': 'rgba(52,62,82,0.3)', 'hillshade-illumination-direction': 315, 'hillshade-illumination-anchor': 'viewport' };
}
/**
 * OpenFreeMap style -> the app's map: tinted toward the --map-* tokens, clutter labels removed
 * (POI, house numbers, road names and shields, airports, villages, suburbs, states), modern labels
 * kept for countries, cities, towns and water but quieter and Latin-script only, hillshade under the
 * water, a hairline coast, and the DEM sources for 3D terrain.
 */
function buildStyle(raw, theme, T) {
  const s = JSON.parse(JSON.stringify(raw));
  // No sprite: icons are stripped below and the only image ('pin-box') is added with addImage, while a failed
  // sprite fetch (a blocker, a CDN hiccup) would count as fatal and swap the live map for the SVG.
  delete s.sprite;
  const dark = theme === 'dark';
  const ink = T.label;
  const seaFill = mix(T.sea, T.water, dark ? 0.1 : 0.22);
  const waterLabel = mix(T.water, T.label, 0.35);
  delete s.sources.ne2_shaded;
  if (s.sources.openmaptiles) s.sources.openmaptiles.attribution = ATTR.osm;
  const dem = { type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: ATTR.dem };
  s.sources.dem = dem;
  s.sources.dem3d = { ...dem };
  const out = [];
  let water = null;
  for (const l of s.layers) {
    const sl = l['source-layer'] || '';
    const p = (l.paint = l.paint || {}), lay = (l.layout = l.layout || {});
    // Patterns need the sprite: the dark style's wood keeps the tinted fill-color set below instead.
    ['fill-pattern', 'line-pattern', 'fill-extrusion-pattern', 'background-pattern'].forEach(k => delete p[k]);
    if (l.type === 'symbol') {
      if (DROP_SOURCE_LAYERS.has(sl) || DROP_LABEL.test(l.id)) continue;
      lay['text-field'] = LATIN_NAME;
      delete lay['icon-image']; delete lay['icon-size']; delete lay['icon-allow-overlap']; delete lay['icon-optional'];
      if (lay['text-size'] !== undefined) lay['text-size'] = scaleNum(lay['text-size'], /country/.test(l.id) ? 0.78 : 0.88);
      if (sl === 'water_name' || sl === 'waterway') {
        lay['text-font'] = ['Noto Sans Italic'];
        Object.assign(p, { 'text-color': waterLabel, 'text-halo-color': alpha(seaFill, 0.85), 'text-halo-width': 1, 'text-halo-blur': 0.5, 'text-opacity': 0.9 });
      } else if (/country/.test(l.id)) {
        Object.assign(lay, { 'text-font': ['Noto Sans Regular'], 'text-transform': 'uppercase', 'text-letter-spacing': 0.16 });
        Object.assign(p, { 'text-color': T.label3, 'text-halo-color': alpha(T.land, 0.9), 'text-halo-width': 1.2, 'text-halo-blur': 0.5, 'text-opacity': 0.75 });
      } else {
        Object.assign(lay, { 'text-font': ['Noto Sans Regular'], 'text-transform': 'none', 'text-letter-spacing': 0 });
        Object.assign(p, { 'text-color': T.label2, 'text-halo-color': alpha(T.land, 0.9), 'text-halo-width': 1.2, 'text-halo-blur': 0.5, 'text-opacity': dark ? 0.72 : 0.8 });
      }
      delete p['icon-opacity'];
      if (NAMED_LAYERS.has(sl)) l.metadata = { ...(l.metadata || {}), 'bs:names': 1, 'bs:filter': l.filter || null };
      out.push(l);
      continue;
    }
    if (l.type === 'background') p['background-color'] = T.land;
    else if (l.type === 'fill' && sl === 'water') { p['fill-color'] = seaFill; p['fill-antialias'] = true; if (l.id === 'water') { water = l; continue; } }
    else if (l.type === 'line' && sl === 'waterway') { p['line-color'] = alpha(T.water, dark ? 0.75 : 0.8); }
    else if (l.type === 'fill' && (sl === 'park' || sl === 'landcover' || sl === 'landuse')) p['fill-color'] = mix(T.land, ink, dark ? 0.035 : 0.03);
    else if (l.type === 'fill' && sl === 'building') { p['fill-color'] = mix(T.land, ink, 0.07); p['fill-outline-color'] = mix(T.land, ink, 0.11); }
    else if (sl === 'aeroway') { if (l.type === 'fill') p['fill-color'] = mix(T.land, ink, 0.05); else p['line-color'] = mix(T.land, ink, 0.08); }
    else if (l.type === 'line' && sl === 'transportation') p['line-opacity'] = scaleNum(p['line-opacity'] ?? 1, /rail/.test(l.id) ? 0.35 : 0.5);
    else if (l.type === 'line' && sl === 'boundary') {
      // country borders only, never the maritime (territorial-water) lines that ring every coast
      if (/state|boundary_3/.test(l.id)) continue;
      l.filter = l.filter ? ['all', l.filter, ['!=', ['get', 'maritime'], 1]] : ['!=', ['get', 'maritime'], 1];
      p['line-color'] = mix(T.land, ink, dark ? 0.3 : 0.24); p['line-opacity'] = 0.7;
    }
    out.push(l);
  }
  // Sea and lake names are Point features. The dark style labels only line-shaped water names, so the
  // night stage never named the Mediterranean: add a point layer like positron's when there is none.
  const waterSyms = out.filter(l => l.type === 'symbol' && l['source-layer'] === 'water_name');
  if (waterSyms.length && waterSyms.every(l => l.layout['symbol-placement'] === 'line')) {
    const line = waterSyms[0], pt = JSON.parse(JSON.stringify(line));
    pt.id = 'water_name_point';
    pt.filter = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];
    ['symbol-placement', 'symbol-spacing', 'text-rotation-alignment', 'text-pitch-alignment'].forEach(k => delete pt.layout[k]);
    Object.assign(pt.layout, { 'text-size': scaleNum(['interpolate', ['linear'], ['zoom'], 0, 10, 8, 14], 0.88), 'text-max-width': 5, 'text-letter-spacing': 0.2 });
    pt.metadata = { ...(pt.metadata || {}), 'bs:names': 1, 'bs:filter': pt.filter };
    out.splice(out.indexOf(line), 0, pt);
  }
  // Hillshade sits under the water (the terrarium DEM carries bathymetry), above land cover.
  const hill = { id: 'hillshade', type: 'hillshade', source: 'dem', paint: hillshadePaint(theme) };
  const edge = { id: 'water-edge', type: 'line', source: 'openmaptiles', 'source-layer': 'water', filter: water ? water.filter : ['==', ['geometry-type'], 'Polygon'],
    paint: { 'line-color': T.water, 'line-opacity': dark ? 0.5 : 0.42, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.35, 10, 1.1] } };
  let at = out.findIndex(l => l.id === 'waterway');
  if (at < 0) at = out.findIndex(l => l.type === 'line' || l.type === 'symbol');
  if (at < 0) at = out.length;
  out.splice(at, 0, hill, ...(water ? [water, edge] : [edge]));
  s.layers = out;
  s.sky = { 'sky-color': T.surface || T.land, 'horizon-color': T.land, 'fog-color': T.land, 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0 };
  return s;
}

/* ---------------------------------------------------------------- registry (bounded WebGL contexts) */
const live = new Set();
let sweepTimer = 0;
function sweep() {
  for (const C of [...live]) {
    if (C.inner.isConnected) { C._detached = 0; continue; }
    if (C._detached) C.remove(); else C._detached = 1; // two strikes: survives a synchronous re-render
  }
  if (!live.size) { clearInterval(sweepTimer); sweepTimer = 0; }
}
/** Number of live map instances (debugging / tests). */
export function liveMaps() { return live.size; }
/** The live controllers themselves (debugging / tests). */
export function liveControllers() { return [...live]; }

/* ---------------------------------------------------------------- controller */
const KEYS_MAP = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '=', '_']);
function bboxOf(coords) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of coords) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
}
function geoCoords(gj) {
  const out = [];
  const walk = c => { if (typeof c[0] === 'number') out.push(c); else c.forEach(walk); };
  (gj && gj.features || []).forEach(f => f && f.geometry && walk(f.geometry.coordinates));
  return out;
}

/**
 * @param {HTMLElement} host  element the map fills (its --map-* tokens and color-scheme style it)
 * @param {object} opts
 *   kind: 'stage' | 'mini'   stage = nav control + rotate/pitch; mini = cooperative gestures, no nav
 *   pins: places [{id, ids?, n, lat, lon, verses?, vc?}]
 *   layer: 'modern' | 'roman', terrain: bool
 *   pinHtml(p) -> popup HTML, onPin(p), paulHtml(props) -> popup HTML ('' = none), label: canvas aria-label
 */
export function createMap(host, opts = {}) {
  const mini = opts.kind === 'mini';
  const inner = document.createElement('div');
  inner.className = 'gl';
  host.appendChild(inner);
  let settled = false, resolveReady;
  const C = {
    map: null, inner, host, kind: mini ? 'mini' : 'stage', removed: false, ready: null,
    pins: [], pinData: [], hiKey: null, layer: opts.layer === 'roman' ? 'roman' : 'modern', terrain: !!opts.terrain,
    paul: null, popup: null, popBtn: null, sig: '', theme: '', lastError: null, styleOK: false, _detached: 0, _fitWant: null,
  };
  C.ready = new Promise(r => { resolveReady = r; });
  let readyTimer = 0, waitVisible = null;
  const settle = ok => {
    if (settled) return;
    settled = true; clearTimeout(readyTimer);
    if (waitVisible) document.removeEventListener('visibilitychange', waitVisible);
    resolveReady(ok);
  };
  // 15s of *visible* time: a background tab renders no frames, so it cannot load and must not fail for it.
  const arm = ms => {
    readyTimer = setTimeout(() => {
      if (!document.hidden) { settle(false); return; }
      waitVisible = () => { if (document.hidden) return; document.removeEventListener('visibilitychange', waitVisible); waitVisible = null; arm(8000); };
      document.addEventListener('visibilitychange', waitVisible);
    }, ms);
  };
  arm(15000);
  live.add(C);
  if (!sweepTimer) sweepTimer = setInterval(sweep, 2500);

  const still = () => RM.matches;
  const dur = ms => (still() ? 0 : ms);
  const ml = () => window.maplibregl;
  const styleReady = () => !!(C.map && C.styleOK); // map.isStyleLoaded() also waits for tiles; layers can be added sooner

  /* ---------- pins */
  const pinR = mini ? 7 : 9;
  function pinKey(p) { return String(p.id); }
  function makePin(p) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pin-btn'; b.dataset.side = 'right'; b.dataset.id = pinKey(p);
    const vs = p.verses || [];
    b.setAttribute('aria-label', `${p.n}${vs.length ? `, ${vs.length === 1 ? 'verse' : 'verses'} ${vs.join(', ')}` : ''}`);
    b.innerHTML = `<span class="pin" aria-hidden="true"></span><span class="pin-label" aria-hidden="true">${esc(p.n)}</span>`;
    const pin = { p, el: b, lbl: b.lastElementChild, w: 0, mk: null };
    // stopPropagation: a pin click must not reach the map (its click would close the popup just opened)
    b.addEventListener('click', e => { e.stopPropagation(); openPin(pin, e.detail === 0); if (opts.onPin) opts.onPin(p); });
    b.addEventListener('dblclick', e => e.stopPropagation());
    return pin;
  }
  function mountPins() {
    if (!C.map) return;
    C.pins.forEach(pin => { if (pin.mk) pin.mk.remove(); });
    C.pins = C.pinData.map(makePin);
    C.pins.forEach(pin => {
      pin.mk = new (ml().Marker)({ element: pin.el, anchor: 'center' }).setLngLat([pin.p.lon, pin.p.lat]).addTo(C.map);
    });
    applyHighlight();
    layoutLabels();
  }
  const matches = (p, want) => pinKey(p) === want || (p.ids || []).some(i => String(i) === want);
  function findPin(id) {
    if (id === null || id === undefined) return null;
    const want = String(id);
    return C.pins.find(pin => matches(pin.p, want)) || null;
  }
  /** The place for an id, whether or not its marker exists yet (the map may still be building). */
  function findPlace(id) {
    if (id === null || id === undefined) return null;
    const want = String(id);
    return C.pinData.find(p => matches(p, want)) || null;
  }
  function applyHighlight() {
    const hit = C.hiKey ? C.pins.find(pin => pinKey(pin.p) === C.hiKey) : null;
    C.pins.forEach(pin => pin.el.classList.toggle('hi', pin === hit));
    inner.classList.toggle('has-hi', !!hit);
  }
  /** Every pin is labelled: right of the pin, else left (crowded), else above / below; a label that
      would overlap anything is hidden and shown on hover, focus or highlight. Recomputed after moves. */
  function layoutLabels() {
    const map = C.map; if (!map || !C.pins.length) return;
    const W = inner.clientWidth, H = inner.clientHeight; if (W < 40 || H < 40) return;
    const items = C.pins.map(pin => ({ pin, pt: map.project([pin.p.lon, pin.p.lat]) }))
      .sort((a, z) => (z.pin.el.classList.contains('hi') - a.pin.el.classList.contains('hi'))
        || ((z.pin.p.verses || []).length - (a.pin.p.verses || []).length) || ((+z.pin.p.vc || 0) - (+a.pin.p.vc || 0)));
    // Obstacles: every pin, and the map's own controls (zoom + compass, credits) in container coordinates.
    const boxes = items.map(({ pt }) => [pt.x - pinR - 1, pt.y - pinR - 1, pt.x + pinR + 1, pt.y + pinR + 1]);
    const ib = inner.getBoundingClientRect();
    inner.querySelectorAll('.maplibregl-ctrl').forEach(c => {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) boxes.push([r.left - ib.left - 2, r.top - ib.top - 2, r.right - ib.left + 2, r.bottom - ib.top + 2]);
    });
    const labels = [];
    const hit = (b, list, gx, gy) => list.some(q => b[0] - gx < q[2] && b[2] + gx > q[0] && b[1] - gy < q[3] && b[3] + gy > q[1]);
    // A label keeps a visible gap from other labels (6px across, 2px up/down) so neighbours never read as one name.
    const free = b => b[0] >= 2 && b[2] <= W - 2 && b[1] >= 2 && b[3] <= H - 2 && !hit(b, boxes, 0, 0) && !hit(b, labels, 6, 2);
    const lh = mini ? 13 : 15, gap = mini ? 5 : 6;
    for (const { pin, pt } of items) {
      if (!pin.w) pin.w = pin.lbl.offsetWidth || Math.round(String(pin.p.n).length * (mini ? 6 : 6.6));
      const w = pin.w, x = pt.x, y = pt.y, r = pinR;
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) { pin.el.dataset.side = 'none'; continue; }
      const cands = [
        ['right', [x + r + gap - 1, y - lh / 2, x + r + gap + w, y + lh / 2]],
        ['left', [x - r - gap - w, y - lh / 2, x - r - gap + 1, y + lh / 2]],
        ['top', [x - w / 2, y - r - 4 - lh, x + w / 2, y - r - 3]],
        ['bottom', [x - w / 2, y + r + 3, x + w / 2, y + r + 4 + lh]],
      ];
      const c = cands.find(k => free(k[1]));
      if (c) { labels.push(c[1]); pin.el.dataset.side = c[0]; }
      else pin.el.dataset.side = 'none';
    }
    syncShadow();
  }
  let layoutRaf = 0;
  const layoutSoon = () => { if (layoutRaf) return; layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; if (!C.removed) layoutLabels(); }); };

  /* ---------- pin shadows: DOM markers take no part in MapLibre's label collision, so an invisible
     symbol per pin (a box the size of the dot plus its label, on the side layoutLabels chose) sits on top
     of the style; basemap names that would run under a pin or its label are then left out. */
  const SHADOW = 'pin-shadow';
  let shadowSig = '';
  function shadowData() {
    const size = mini ? 11 : 12, r = pinR, gap = mini ? 5 : 6;
    return { type: 'FeatureCollection', features: C.pins.map(pin => {
      const side = pin.el.dataset.side;
      const [a, o] = side === 'left' ? ['right', [-(r + gap) / size, 0]] : side === 'top' ? ['bottom', [0, -(r + 4) / size]]
        : side === 'bottom' ? ['top', [0, (r + 3) / size]] : ['left', [(r + gap) / size, 0]];
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [pin.p.lon, pin.p.lat] }, properties: { t: side === 'none' ? '' : String(pin.p.n || ''), a, o } };
    }) };
  }
  function syncShadow() {
    const map = C.map; if (!map || !styleReady()) return;
    const src = map.getSource(SHADOW); if (!src) return;
    const fc = shadowData(), sig = JSON.stringify(fc);
    if (sig === shadowSig) return;
    shadowSig = sig; src.setData(fc);
  }
  function applyShadow() {
    const map = C.map, s = 2 * pinR + 4;
    if (!map.hasImage('pin-box')) map.addImage('pin-box', { width: s, height: s, data: new Uint8Array(s * s * 4) });
    if (map.getLayer(SHADOW)) map.removeLayer(SHADOW);
    if (map.getSource(SHADOW)) map.removeSource(SHADOW);
    shadowSig = '';
    map.addSource(SHADOW, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: SHADOW, type: 'symbol', source: SHADOW,
      layout: { 'icon-image': 'pin-box', 'icon-allow-overlap': true, 'icon-padding': 2,
        'text-field': ['get', 't'], 'text-font': ['Noto Sans Regular'], 'text-size': mini ? 11 : 12, 'text-max-width': 40,
        'text-anchor': ['get', 'a'], 'text-offset': ['get', 'o'], 'text-allow-overlap': true, 'text-padding': 3 },
      paint: { 'icon-opacity': 0, 'text-opacity': 0 } });
    syncShadow();
  }
  /** Basemap place and water names that a pin of the same name already shows are filtered out. */
  function applyPinNames() {
    const map = C.map; if (!map || !styleReady()) return;
    const names = [...new Set(C.pinData.map(p => String(p.n || '')).filter(Boolean))];
    const not = ['!', ['in', LATIN_NAME, ['literal', names]]];
    for (const l of map.getStyle().layers) {
      const md = l.metadata; if (!md || !md['bs:names']) continue;
      const base = md['bs:filter'] || null;
      try { map.setFilter(l.id, names.length ? (base ? ['all', base, not] : not) : base); } catch (e) { C.lastError = e; }
    }
  }

  /* ---------- popups */
  /** Never wider than the map less a margin (a 350px phone stage, the drawer's mini map). */
  const popMax = () => `${Math.max(160, Math.min(mini ? 240 : 280, inner.clientWidth - 24))}px`;
  function popup() {
    if (C.popup) return C.popup;
    C.popup = new (ml().Popup)({ closeButton: true, closeOnClick: true, maxWidth: popMax(), offset: pinR + 6, className: 'bs-pop', focusAfterOpen: false });
    // the close button's "×" text is replaced by a drawn cross (CSS); its aria-label stays
    C.popup.on('open', () => fixClose(C.popup));
    C.popup.on('close', () => {
      const btn = C.popBtn; C.popBtn = null;
      const a = document.activeElement;
      if (btn && btn.isConnected && (!a || a === document.body || !a.isConnected)) btn.focus({ preventScroll: true });
    });
    return C.popup;
  }
  function openPin(pin, keyboard) {
    if (!C.map || !opts.pinHtml) return;
    const html = opts.pinHtml(pin.p); if (!html) return;
    const pop = popup();
    C.popBtn = null; // re-targeting an open popup must not bounce focus back to the previous pin
    pop.setMaxWidth(popMax()).setLngLat([pin.p.lon, pin.p.lat]).setHTML(scrollBox(html));
    if (!pop.isOpen()) pop.addTo(C.map);
    fixClose(pop); // setHTML re-creates the close button without its name
    C.popBtn = pin.el;
    keepInView(pop);
    if (keyboard) { const a = pop.getElement() && pop.getElement().querySelector('.maplibregl-popup-content :is(a[href], button[data-v])'); if (a) a.focus({ preventScroll: true }); }
  }
  /** MapLibre popups do not auto-pan: once placed, pan the map so the whole popup sits 12px inside it
      (a jump under reduced motion). A popup taller or wider than the map keeps its top / left edge in view. */
  let panTries = 0;
  function keepInView(pop, again) {
    if (!again) panTries = 0;
    requestAnimationFrame(() => {
      const map = C.map, el = pop.getElement();
      if (!map || C.removed || !pop.isOpen() || !el || !el.isConnected) return;
      const r = el.getBoundingClientRect(), b = inner.getBoundingClientRect(), m = 12;
      const over = (lo, hi, a, z) => (z - a > hi - lo - 2 * m || a < lo + m ? a - (lo + m) : z > hi - m ? z - (hi - m) : 0);
      const dx = over(b.left, b.right, r.left, r.right), dy = over(b.top, b.bottom, r.top, r.bottom);
      if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || ++panTries > 2) return;
      map.once('moveend', () => keepInView(pop, true)); // the anchor can flip as the pin moves: check once more
      map.panBy([Math.round(dx), Math.round(dy)], { duration: dur(280) });
    });
  }

  /* ---------- camera */
  function safePad(want) {
    const W = inner.clientWidth, H = inner.clientHeight;
    const kx = Math.min(1, Math.max(0, (W - 60) / Math.max(1, want.left + want.right)));
    const ky = Math.min(1, Math.max(0, (H - 60) / Math.max(1, want.top + want.bottom)));
    return { top: Math.round(want.top * ky), bottom: Math.round(want.bottom * ky), left: Math.round(want.left * kx), right: Math.round(want.right * kx) };
  }
  const tilt = () => (C.terrain ? { pitch: 55, bearing: -12 } : { pitch: 0, bearing: 0 });
  function move(cam, ms) {
    const map = C.map; if (!map) return;
    if (!ms || still()) map.jumpTo(cam); else map.easeTo({ ...cam, duration: ms, essential: false });
  }
  /** Height the expanded credits bar takes from the bottom of the stage (0 when folded into the (i) button). */
  function creditsH() {
    if (mini) return 0;
    const at = inner.querySelector('.maplibregl-ctrl-attrib');
    if (at && at.classList.contains('maplibregl-compact') && !at.classList.contains('maplibregl-compact-show')) return 0;
    if (inner.clientWidth < 640 || inner.clientHeight < 240) return 0; // folded once the map has loaded
    return (at && at.offsetHeight > 0 ? at.offsetHeight : 26) + 8;
  }
  function fitBox(box, animate, maxZoom) {
    const map = C.map; if (!map || !box) return;
    const W = inner.clientWidth, H = inner.clientHeight;
    if (W < 40 || H < 40) { C._fitWant = { box, maxZoom }; return; }
    C._fitWant = null;
    const pad = safePad(mini ? { top: 26, bottom: 22, left: 24, right: 64 } : { top: 52, bottom: 40 + creditsH(), left: 52, right: 110 });
    let cam = null;
    try { cam = map.cameraForBounds(box, { padding: pad, maxZoom, ...tilt() }); } catch (e) { cam = null; }
    if (!cam) return;
    move({ ...cam, ...tilt() }, animate ? 900 : 0);
  }
  C.fit = (animate = false) => {
    if (!C.map) { C._fitWant = { all: true }; return; }
    C.userMoved = false; C.frame = 'all';
    const pts = C.pinData;
    if (pts.length === 1) move({ center: [pts[0].lon, pts[0].lat], zoom: 8, ...tilt() }, animate ? 900 : 0);
    else if (pts.length) {
      const b = bboxOf(pts.map(p => [p.lon, p.lat]));
      // a tiny spread (two names for one town) still gets a regional view
      const span = Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]);
      if (span < 0.02) move({ center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 8, ...tilt() }, animate ? 900 : 0);
      else fitBox(b, animate, 10);
    } else if (C.paul) fitBox(bboxOf(geoCoords(C.paul)), animate, 7);
    else move({ center: [31, 34], zoom: 4, ...tilt() }, 0);
  };
  C.fitPaul = (animate = true) => {
    if (!C.map) { C._fitWant = { paul: true }; return; }
    C.userMoved = false; C.frame = 'paul';
    if (C.paul) fitBox(bboxOf(geoCoords(C.paul)), animate, 7);
  };
  function runWant(w) {
    if (!w) return;
    if (w.box) fitBox(w.box, false, w.maxZoom);
    else if (w.pin) C.focus(w.pin.id);
    else if (w.paul) C.fitPaul(false);
    else C.fit(false);
  }

  /* ---------- public API */
  C.setPins = (pts = []) => {
    C.pinData = (pts || []).filter(p => p && isFinite(+p.lat) && isFinite(+p.lon)).map(p => ({ ...p, lat: +p.lat, lon: +p.lon }));
    if (C.popup) C.popup.remove();
    mountPins();
    applyPinNames();
  };
  /** Highlight a place without moving the camera (null clears). Before the markers exist (the map is
      still building) the id is resolved against the place data; mountPins() applies the highlight. */
  C.highlight = id => {
    const p = (findPin(id) || {}).p || findPlace(id);
    C.hiKey = p ? pinKey(p) : null;
    applyHighlight(); layoutSoon();
    return p;
  };
  /** Highlight a place and ease to it (zoom ~8); null (or an unknown id) clears and re-fits every pin. */
  C.focus = id => {
    const p = C.highlight(id);
    if (!C.map) { C._fitWant = p ? { pin: p } : { all: true }; return; }
    if (p) move({ center: [p.lon, p.lat], zoom: 8, ...tilt() }, 700);
    else C.fit(true);
  };
  C.setLayer = kind => {
    C.layer = kind === 'roman' ? 'roman' : 'modern';
    inner.dataset.mapLayer = C.layer;
    if (styleReady()) applyLayer();
  };
  C.setTerrain = on => {
    C.terrain = !!on;
    if (!C.map) return;
    if (styleReady()) applyTerrain();
    move({ pitch: tilt().pitch, bearing: tilt().bearing }, 1000);
  };
  /** Paul's journeys as line + circle layers, one colour per journey (null removes them). `routes` lists the
      route_ids this chapter tells (Acts 13 → [1]); the other journeys are dimmed. */
  C.setPaul = (gj, routes) => {
    C.paul = gj && gj.features ? gj : null;
    C.paulRoutes = routes && routes.length ? routes : null;
    if (styleReady()) applyPaul();
  };
  /** Re-read theme + tokens; rebuild the style only when they changed. */
  C.restyle = () => {
    if (!C.map || C.removed) return;
    const theme = themeOf(inner), T = readTokens(inner, theme), sig = theme + JSON.stringify(T);
    if (sig === C.sig) return;
    C.sig = sig;
    fetchStyle(theme).then(raw => {
      if (C.removed || !C.map || C.sig !== sig) return;
      C.theme = theme; C.tokens = T; C.host.dataset.mapTheme = theme; inner.dataset.mapTheme = theme;
      C.styleOK = false;
      C.map.setStyle(buildStyle(raw, theme, T), { diff: false });
    }).catch(e => { C.lastError = e; if (C.sig === sig) C.sig = ''; }); // a failed fetch is retried by the next restyle()
  };
  /** Move the live map into a new host (the drawer re-rendered the same chapter): no new WebGL context. */
  C.rehost = el => {
    if (!el || C.removed) return;
    C.host = el; el.appendChild(inner); C._detached = 0;
    if (C.map) { C.map.resize(); C.restyle(); layoutSoon(); }
  };
  C.remove = () => {
    if (C.removed) return;
    C.removed = true; live.delete(C);
    clearTimeout(readyTimer); settle(false);
    if (layoutRaf) cancelAnimationFrame(layoutRaf);
    try { if (C.popup) C.popup.remove(); } catch (e) { /* ignore */ }
    try { if (C.map) C.map.remove(); } catch (e) { /* already gone */ }
    C.map = null; C.pins = [];
    inner.remove();
  };

  /* ---------- style-dependent layers (re-applied after every style load) */
  function setLabels(visible) {
    const map = C.map;
    for (const l of map.getStyle().layers) if (l.type === 'symbol' && !String(l.id).startsWith('paul')) map.setLayoutProperty(l.id, 'visibility', visible ? 'visible' : 'none');
  }
  function applyLayer() {
    const map = C.map, roman = C.layer === 'roman', dark = C.theme === 'dark';
    setLabels(!roman);
    // Outside the atlas' coverage the background shows through: a tone between the atlas' sea (#b0c5d8)
    // and land (#b9ccae), dimmed like the atlas itself on the night stage, so its edge does not stand out.
    if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', roman ? (dark ? '#848a8b' : '#b5c6c6') : (C.tokens || {}).land || (dark ? '#141418' : '#f1eee8'));
    const ids = DARE_PARTS.map((b, i) => 'dare' + i);
    if (roman && !map.getSource(ids[0])) {
      const before = map.getLayer('paul-casing') ? 'paul-casing' : map.getLayer(SHADOW) ? SHADOW : undefined;
      // Night stage: the parchment atlas as a dimmed paper map (an inverted atlas turned garish up close).
      const paint = dark
        ? { 'raster-brightness-max': 0.7, 'raster-saturation': -0.3, 'raster-contrast': -0.1, 'raster-fade-duration': dur(200) }
        : { 'raster-saturation': -0.12, 'raster-fade-duration': dur(200) };
      DARE_PARTS.forEach((bounds, i) => {
        map.addSource(ids[i], { type: 'raster', tiles: [DARE_TILES], tileSize: 256, minzoom: 3, maxzoom: 11, bounds, attribution: ATTR.dare });
        map.addLayer({ id: ids[i], type: 'raster', source: ids[i], paint }, before);
      });
    } else if (!roman && map.getSource(ids[0])) {
      ids.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); });
    }
  }
  function applyTerrain() {
    const map = C.map;
    try { map.setTerrain(C.terrain ? { source: 'dem3d', exaggeration: 1.4 } : null); } catch (e) { C.lastError = e; }
  }
  function applyPaul() {
    const map = C.map;
    ['paul-pt', 'paul-line', 'paul-casing'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    if (map.getSource('paul')) map.removeSource('paul');
    if (!C.paul) return;
    const T = C.tokens || readTokens(inner, C.theme || themeOf(inner));
    map.addSource('paul', { type: 'geojson', data: C.paul });
    const lines = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
    const width = ['interpolate', ['linear'], ['zoom'], 3, 1.4, 6, 2.2, 9, 3];
    const offset = ['*', ['coalesce', ['get', 'offset'], 0], 1];
    const color = ['match', ['get', 'route_id'], ...PAUL_ROUTES.flatMap(r => [r.id, r.color]), T.nt];
    const focus = (on, off) => (C.paulRoutes ? ['match', ['get', 'route_id'], C.paulRoutes, on, off] : on);
    map.addLayer({ id: 'paul-casing', type: 'line', source: 'paul', filter: lines, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': T.land, 'line-opacity': focus(0.55, 0.25), 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3.4, 6, 4.4, 9, 5.4], 'line-offset': offset } });
    map.addLayer({ id: 'paul-line', type: 'line', source: 'paul', filter: lines, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-opacity': focus(0.92, 0.32), 'line-width': width, 'line-offset': offset } });
    // Stops stay neutral: 13 of them belong to more than one journey (their popup names each).
    map.addLayer({ id: 'paul-pt', type: 'circle', source: 'paul', filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
      paint: { 'circle-color': T.label, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 7, 4.5, 10, 6], 'circle-stroke-color': T.land, 'circle-stroke-width': 1.5 } });
  }
  function applyOverlays() {
    try { applyLayer(); applyPaul(); applyShadow(); applyTerrain(); applyPinNames(); } catch (e) { C.lastError = e; }
  }

  /* ---------- build */
  (async () => {
    const ok = await loadMapLibre();
    if (!ok || C.removed) { settle(false); return; }
    const theme = themeOf(inner), T = readTokens(inner, theme);
    let raw;
    try { raw = await fetchStyle(theme); } catch (e) { C.lastError = e; settle(false); return; }
    if (C.removed) { settle(false); return; }
    C.theme = theme; C.tokens = T; C.sig = theme + JSON.stringify(T);
    host.dataset.mapTheme = theme; inner.dataset.mapTheme = theme; inner.dataset.mapLayer = C.layer;
    const M = ml();
    let map;
    try {
      map = new M.Map({
        container: inner, style: buildStyle(raw, theme, T), center: [35.3, 31.8], zoom: 6,
        attributionControl: { compact: true }, minZoom: 2, maxZoom: mini ? 12 : 14, maxPitch: 60,
        dragRotate: !mini, pitchWithRotate: !mini, touchPitch: !mini, boxZoom: false,
        cooperativeGestures: mini, renderWorldCopies: false, fadeDuration: still() ? 0 : 250,
      });
    } catch (e) { C.lastError = e; settle(false); return; }
    C.map = map;
    // Credits start folded into the (i) button where they would cover the map (mini map, phone stage). The
    // control opens itself when the first source's credits arrive, long before 'load' (which waits for every
    // terrain tile): fold it then. Its own listener was added in the constructor, so ours runs after it, and
    // once folded MapLibre does not re-open it.
    if (mini || inner.clientWidth < 640 || inner.clientHeight < 240) {
      const fold = () => {
        const at = inner.querySelector('.maplibregl-ctrl-attrib');
        if (!at || !at.classList.contains('maplibregl-compact')) return;
        at.classList.remove('maplibregl-compact-show'); at.removeAttribute('open');
        map.off('sourcedata', fold); map.off('styledata', fold);
      };
      map.on('sourcedata', fold); map.on('styledata', fold);
    }
    if (opts.label) map.getCanvas().setAttribute('aria-label', opts.label);
    if (mini) { map.touchZoomRotate.disableRotation(); map.keyboard.disableRotation(); }
    else map.addControl(new M.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }), 'top-right');
    // Ready = the basemap has produced tiles. MapLibre's 'load' also waits for every terrain and atlas
    // tile, so a slow connection could hit the timeout with a map already drawn; a live map is never
    // swapped for the SVG. Fatal before that: the style, WebGL, the basemap source (TileJSON) or three
    // basemap tile errors; a 'load' with no basemap tile at all (it drew only background and relief).
    let basemapErrs = 0, baseTiles = 0;
    map.on('sourcedata', e => {
      if (!e || e.sourceId !== 'openmaptiles' || !e.tile) return;
      baseTiles++;
      if (!settled && C.styleOK) settle(true);
    });
    map.on('error', e => {
      const err = (e && e.error) || e; C.lastError = err;
      if (settled) return; // after the first tiles a missing tile is not fatal
      const sid = e && (e.sourceId || (e.source && e.source.id));
      if (sid && sid !== 'openmaptiles') return; // terrain, the Roman atlas, Paul, pin shadows: never fatal
      if (!sid || !e.tile || ++basemapErrs >= 3) settle(false);
    });
    map.on('webglcontextlost', () => { if (!settled) settle(false); });
    map.on('style.load', () => { C.styleOK = true; applyOverlays(); if (!settled && baseTiles) settle(true); });
    map.once('load', () => {
      if (baseTiles) settle(true);
      else if (inner.clientWidth >= 40 && inner.clientHeight >= 40) settle(false);
      // fallback for the early fold above
      if (mini || inner.clientWidth < 640 || inner.clientHeight < 240) { const at = inner.querySelector('.maplibregl-ctrl-attrib'); if (at) { at.classList.remove('maplibregl-compact-show'); at.removeAttribute('open'); } }
    });
    map.on('moveend', layoutSoon);
    // Until the reader pans or zooms, the framing follows the container (the stage head can reflow).
    map.on('movestart', e => { if (e && e.originalEvent) C.userMoved = true; });
    let refit = 0;
    map.on('resize', () => {
      if (C._fitWant && inner.clientWidth >= 40 && inner.clientHeight >= 40) { const w = C._fitWant; C._fitWant = null; runWant(w); }
      else if (!C.userMoved && !C.hiKey) { clearTimeout(refit); refit = setTimeout(() => { if (!C.removed && !C.userMoved && !C.hiKey) { if (C.frame === 'paul') C.fitPaul(false); else C.fit(false); } }, 120); }
      layoutSoon();
    });
    // Paul's stops: popup on click, pointer cursor on hover.
    map.on('click', 'paul-pt', e => {
      const f = e.features && e.features[0]; if (!f || !opts.paulHtml) return;
      const html = opts.paulHtml(f.properties || {}); if (!html) return;
      const at = f.geometry.coordinates.slice(0, 2);
      C.popBtn = null;
      // Open after this click has finished dispatching: an open popup's close-on-click listener is still
      // queued for this same event and would close a popup re-opened here synchronously.
      setTimeout(() => {
        if (C.removed || C.map !== map) return;
        const pop = popup(); C.popBtn = null;
        pop.setMaxWidth(popMax()).setLngLat(at).setHTML(scrollBox(html));
        if (!pop.isOpen()) pop.addTo(map);
        fixClose(pop);
        keepInView(pop);
      }, 0);
    });
    map.on('mouseenter', 'paul-pt', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'paul-pt', () => { map.getCanvas().style.cursor = ''; });
    // Keys the map uses (pan / zoom) must not also reach the app's global shortcuts (← → change chapter);
    // Esc closes an open popup before it closes the panel.
    inner.addEventListener('keydown', e => {
      if (e.key === 'Escape' && C.popup && C.popup.isOpen()) { e.stopPropagation(); e.preventDefault(); C.popup.remove(); return; }
      if (KEYS_MAP.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
    });
    // Verse numbers in a place popup: show that verse in the text.
    inner.addEventListener('click', e => {
      const b = e.target && e.target.closest && e.target.closest('.bs-pop button[data-v]');
      if (b && opts.onVerse) { e.preventDefault(); opts.onVerse(+b.dataset.v); }
    });
    if (C.pinData.length) mountPins();
    const want = C._fitWant; C._fitWant = null;
    runWant(want || { all: true });
    C.restyle(); // the theme may have changed while the style was downloading (a no-op otherwise)
  })().catch(e => { C.lastError = e; settle(false); });

  if (opts.pins) C.pinData = (opts.pins || []).filter(p => p && isFinite(+p.lat) && isFinite(+p.lon)).map(p => ({ ...p, lat: +p.lat, lon: +p.lon }));
  return C;
}
