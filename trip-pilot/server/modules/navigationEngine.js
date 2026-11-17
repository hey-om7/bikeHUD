/**
 * Navigation Engine - fetches real route + surrounding road geometry.
 *
 * Produces the raw geographic data that frameRenderer.js turns into
 * heading-up, view-culled screen frames for the ESP32 display:
 *
 *   {
 *     geometry:     [[lng,lat], ...]        // dense route polyline (the WHITE road)
 *     roads:        [[[lng,lat], ...], ...] // nearby roads within a corridor (GRAY)
 *     turnPoints:   [{ dist, direction, instruction }] // upcoming-maneuver markers
 *     totalDistance: meters
 *     summary:      { distance, duration, startAddress, endAddress }
 *   }
 *
 * ROUTING PROVIDERS (a single abstraction — callers never pick a provider):
 *   1. Google Directions API  (primary, if GOOGLE_MAPS_API_KEY is set)
 *   2. OSRM  (OpenStreetMap routing engine, automatic fallback, no key needed)
 *
 * The route geometry is ALWAYS taken verbatim from the provider's response.
 * We never interpolate, smooth, curve, or synthesise the route ourselves, and
 * we never substitute a straight origin->destination line. If BOTH providers
 * fail, generateRoute throws — we surface the failure rather than fabricate.
 *
 * Nearby roads: OpenStreetMap Overpass API `way(around:...)` along the route
 *               (no key needed, bounded to a thin corridor around the path).
 */

import { Client } from '@googlemaps/google-maps-services-js';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// OSRM (OpenStreetMap routing engine) — the OSM-compatible routing service
// already used elsewhere in this project (see python-app/get_route.py).
// This is a REAL routing engine that returns road-following geometry; OSM map
// data alone cannot compute a route, OSRM is what does the routing.
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';

// Corridor half-width (meters) for the "nearby roads" Overpass query.
// Keep this tight — we only ever render a small local view on the device.
const ROAD_CORRIDOR_M = 130;

// Overpass endpoints + the highway classes worth drawing as gray context roads.
//
// Public Overpass instances routinely answer with HTTP 429/504 or an XML error
// body under load, and the gray road layer is the difference between "a real
// map" and "one white line on black". So we try mirrors in order instead of
// giving up on the first failure.
const OVERPASS_URLS = (process.env.OVERPASS_URLS ||
  'https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter'
).split(',').map((s) => s.trim()).filter(Boolean);
const HIGHWAY_FILTER =
  '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street|road)$';

// Generated routes are cached briefly, keyed by rounded source/destination.
// /api/navigate, /api/navigate/preview and /api/navigate/geo are all called for
// the same trip (the ESP preview page hits two of them back to back), and each
// call used to fire its own Overpass query. Public Overpass rate-limits by IP,
// so the second query reliably came back empty and the map lost its gray roads.
const ROUTE_CACHE_TTL_MS = 2 * 60 * 1000;
const ROUTE_CACHE_MAX = 32;

export class NavigationEngine {
  constructor() {
    this.client = new Client({});
    this.routeCache = new Map(); // key -> { at, route }
  }

  _cacheKey(sLat, sLng, dLat, dLng) {
    // ~11 m resolution: fine enough that a different key means a different trip,
    // coarse enough that GPS jitter between calls still hits the same entry.
    const r = (v) => v.toFixed(4);
    return `${r(sLat)},${r(sLng)}>${r(dLat)},${r(dLng)}`;
  }

  /**
   * Generate navigation data from source to destination.
   * Returns raw geographic geometry (see module header) ready for framing.
   *
   * Provider order: Google Directions (primary) -> OSRM (fallback). The route
   * geometry is taken verbatim from whichever provider answers; we never
   * synthesise it. Throws if BOTH providers fail.
   */
  async generateRoute(sourceLat, sourceLng, destLat, destLng, { waitForRoads = true } = {}) {
    const key = this._cacheKey(sourceLat, sourceLng, destLat, destLng);
    const hit = this.routeCache.get(key);
    if (hit && Date.now() - hit.at < ROUTE_CACHE_TTL_MS) {
      console.log('[NAV] Route served from cache');
      return hit.route;
    }

    let route = null;

    // 1. Primary provider: Google Directions (only if a key is configured).
    if (GOOGLE_MAPS_API_KEY) {
      try {
        route = await this.generateGoogleRoute(sourceLat, sourceLng, destLat, destLng);
        console.log('[NAV] Route provided by Google Directions');
      } catch (e) {
        // Any Google failure (403 / auth / quota / unavailable / invalid /
        // routing / network) falls through to the OSRM fallback below.
        console.error('[NAV] Google Directions failed, falling back to OSRM:', e.message);
      }
    }

    // 2. Fallback provider: OSRM (OpenStreetMap routing engine).
    if (!route) {
      route = await this.generateOSRMRoute(sourceLat, sourceLng, destLat, destLng);
      console.log('[NAV] Route provided by OSRM (OpenStreetMap)');
    }

    // Fetch surrounding roads for the gray context layer (best-effort).
    // A mid-ride reroute can't wait for Overpass (up to ~40 s across mirrors):
    // it returns the route at once and the roads attach in the background. The
    // live session holds this same object, so they appear in later frames.
    if (!waitForRoads) {
      route.roads = route.roads || [];
      this.ensureRoads(route, { attempts: 3, delayMs: 10000 }).catch(() => {});
      return route; // not cached: no road layer yet
    }
    await this.ensureRoads(route);

    // Only cache once the roads layer is attached, so a cache hit is a complete
    // route. Evict oldest-first to keep the map bounded.
    this.routeCache.set(key, { at: Date.now(), route });
    if (this.routeCache.size > ROUTE_CACHE_MAX) {
      this.routeCache.delete(this.routeCache.keys().next().value);
    }

    return route;
  }

  /**
   * Attach the gray surrounding-road layer to `route`, in place.
   *
   * Public Overpass instances are frequently overloaded (504s and 15 s+ waits
   * are routine), and the layer is what makes the display read as a map rather
   * than one white line on black. So this is retryable and mutates the route
   * object: a caller can start navigation immediately with an empty layer and
   * keep retrying in the background — because the live navigation session holds
   * this same object, the roads simply appear in subsequent frames once they
   * land, with no reroute and no interruption.
   *
   * Never throws; a permanent failure just leaves the route-only view.
   */
  async ensureRoads(route, { attempts = 1, delayMs = 0 } = {}) {
    for (let i = 0; i < attempts; i++) {
      if (route.roads && route.roads.length) return route.roads;
      if (i > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
      try {
        const roads = await this.fetchNearbyRoads(route.geometry);
        if (roads.length) {
          route.roads = roads;
          return roads;
        }
      } catch (e) {
        console.error(`[NAV] Nearby-road fetch attempt ${i + 1}/${attempts} failed:`, e.message);
      }
    }
    route.roads = route.roads || [];
    return route.roads;
  }

  /**
   * Real Google Directions route → dense geometry + maneuver turn points.
   */
  async generateGoogleRoute(srcLat, srcLng, dstLat, dstLng) {
    const response = await this.client.directions({
      params: {
        origin: { lat: srcLat, lng: srcLng },
        destination: { lat: dstLat, lng: dstLng },
        mode: 'driving',
        key: GOOGLE_MAPS_API_KEY
      }
    });

    if (response.data.status !== 'OK' || !response.data.routes.length) {
      throw new Error(`Directions API returned: ${response.data.status}`);
    }

    const route = response.data.routes[0];
    const leg = route.legs[0];

    // Dense geometry: prefer per-step polylines (higher resolution than overview).
    let geometry = [];
    // Vertex index where each step ends. Recorded while building the polyline so
    // a maneuver is pinned to ITS OWN occurrence on the route. A global
    // nearest-vertex search put the turn on the wrong pass whenever the route
    // came back past the same junction (out-and-back, loops, U-turns).
    const stepEndIdx = [];
    for (const step of leg.steps) {
      const pts = decodePolyline(step.polyline.points); // [[lat,lng], ...]
      for (const [lat, lng] of pts) {
        const c = [lng, lat];
        // Avoid duplicate seam points between consecutive steps.
        const last = geometry[geometry.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) geometry.push(c);
      }
      stepEndIdx.push(geometry.length - 1);
    }
    let haveStepIdx = true;
    if (geometry.length < 2) {
      geometry = decodePolyline(route.overview_polyline.points).map(([lat, lng]) => [lng, lat]);
      haveStepIdx = false;
    }

    const cum = cumulativeDistances(geometry);
    const totalDistance = cum[cum.length - 1];

    // Turn points: at each step boundary, the maneuver that STARTS the next step.
    const turnPoints = [];
    let searchFrom = 0;
    for (let i = 0; i < leg.steps.length; i++) {
      const step = leg.steps[i];
      const idx = haveStepIdx
        ? stepEndIdx[i]
        : nearestVertexIndexFrom(geometry, step.end_location.lng, step.end_location.lat, searchFrom);
      searchFrom = idx;
      const dist = cum[idx];
      const next = leg.steps[i + 1];
      turnPoints.push({
        dist,
        direction: next ? this.maneuverToDirection(next.maneuver || 'straight') : 'S',
        instruction: next ? this.cleanInstruction(next.html_instructions) : 'Arrive'
      });
    }

    return {
      geometry,
      turnPoints,
      totalDistance,
      summary: {
        distance: leg.distance.text,
        duration: leg.duration.text,
        startAddress: leg.start_address,
        endAddress: leg.end_address
      }
    };
  }

  /**
   * OSRM fallback route (OpenStreetMap routing engine).
   *
   * Requests a real driving route from OSRM and uses its road-following
   * geometry verbatim. OSRM returns GeoJSON coordinates already in [lng,lat]
   * order (our internal format) and per-step maneuvers for turn points.
   *
   * Throws on any failure (HTTP error, non-"Ok" code, empty routes, network) —
   * we never fabricate a route as a substitute.
   */
  async generateOSRMRoute(srcLat, srcLng, dstLat, dstLng) {
    // OSRM path format: /route/v1/driving/{lon},{lat};{lon},{lat}
    const coords = `${srcLng},${srcLat};${dstLng},${dstLat}`;
    const url =
      `${OSRM_URL}/route/v1/driving/${coords}` +
      `?overview=full&geometries=geojson&steps=true`;

    let res;
    try {
      res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'TripPilot/1.0' },
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      throw new Error(`OSRM network error: ${e.message}`);
    }
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);

    const data = await res.json();
    if (data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
      throw new Error(`OSRM routing failed: ${data.code || 'no route'}`);
    }

    const route = data.routes[0];

    // Provider geometry taken verbatim — already [[lng,lat], ...].
    const geometry = route.geometry.coordinates.map(([lng, lat]) => [lng, lat]);
    if (geometry.length < 2) {
      throw new Error('OSRM returned degenerate geometry');
    }

    const cum = cumulativeDistances(geometry);
    const totalDistance = route.distance ?? cum[cum.length - 1];

    // Turn points from OSRM step maneuvers. Each step's maneuver marks where the
    // NEXT road segment begins; place the marker at that maneuver location.
    const turnPoints = [];
    const steps = (route.legs && route.legs[0] && route.legs[0].steps) || [];
    let searchFrom = 0;
    for (const step of steps) {
      const m = step.maneuver || {};
      const loc = m.location; // [lng, lat]
      if (!loc) continue;
      // Skip the "depart" pseudo-maneuver at distance 0: it is not something the
      // rider has to do, and it made the first frames read "Depart / 0 m" instead
      // of counting down to the first real turn.
      if ((m.type || '').toLowerCase() === 'depart') continue;
      // Search forward only: maneuvers are in travel order, so each one lies at
      // or after the previous. See generateGoogleRoute for why a global search
      // misplaces turns on routes that revisit a junction.
      const idx = nearestVertexIndexFrom(geometry, loc[0], loc[1], searchFrom);
      searchFrom = idx;
      turnPoints.push({
        dist: cum[idx],
        direction: this.osrmManeuverToDirection(m),
        instruction: this.osrmInstruction(step, m)
      });
    }
    // Ensure a final "arrive" marker at the destination.
    if (!turnPoints.length || turnPoints[turnPoints.length - 1].dist < totalDistance - 1) {
      turnPoints.push({ dist: totalDistance, direction: 'S', instruction: 'Arrive' });
    }

    return {
      geometry,
      turnPoints,
      totalDistance,
      summary: {
        distance: totalDistance > 1000
          ? `${(totalDistance / 1000).toFixed(1)} km`
          : `${Math.round(totalDistance)} m`,
        duration: `${Math.max(1, Math.round((route.duration || 0) / 60))} min`,
        startAddress: `${srcLat.toFixed(4)}, ${srcLng.toFixed(4)}`,
        endAddress: `${dstLat.toFixed(4)}, ${dstLng.toFixed(4)}`
      }
    };
  }

  /**
   * Fetch roads within ROAD_CORRIDOR_M of the route via Overpass `around`.
   * Downsamples the route for the query so the request stays small even on
   * long routes; returns an array of [[lng,lat], ...] polylines.
   *
   * Tries each mirror in OVERPASS_URLS until one answers with usable JSON.
   */
  async fetchNearbyRoads(geometry) {
    if (!geometry || geometry.length < 2) return [];

    // Downsample to ~1 point / 60m, cap total coords to keep the query bounded.
    const cum = cumulativeDistances(geometry);
    const sampled = [];
    let nextAt = 0;
    for (let i = 0; i < geometry.length; i++) {
      if (cum[i] >= nextAt || i === geometry.length - 1) {
        sampled.push(geometry[i]);
        nextAt = cum[i] + 60;
      }
      if (sampled.length >= 300) break;
    }

    // Overpass `around` takes a flat lat,lon,lat,lon,... list.
    const coordList = sampled.map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join(',');
    const query =
      `[out:json][timeout:25];` +
      `way(around:${ROAD_CORRIDOR_M},${coordList})["highway"~"${HIGHWAY_FILTER}"];` +
      `out geom;`;

    let lastErr = null;
    for (const url of OVERPASS_URLS) {
      try {
        const raw = await this._overpassQuery(url, query);
        // Overpass also returns the route's OWN way(s). Those are already drawn
        // as the white route, so keeping them wastes slots in the device's
        // 10-road budget — and because side roads are ranked by proximity, the
        // road under the rider took the TOP slots and crowded out the actual
        // surrounding context.
        const roads = raw.filter((poly) => !isOnRoute(poly, geometry));
        console.log(`[NAV] Overpass returned ${raw.length} ways, ${roads.length} context roads after dropping the route itself (${url})`);
        if (roads.length) return roads;
        lastErr = new Error('empty result');
      } catch (e) {
        lastErr = e;
        console.error(`[NAV] Overpass mirror failed (${url}): ${e.message}`);
      }
    }
    throw lastErr || new Error('no Overpass mirror available');
  }

  /** Single Overpass request -> [[lng,lat], ...] polylines. */
  async _overpassQuery(url, query) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass (Apache/mod_security) 406s requests without a normal UA.
        'User-Agent': 'TripPilot/1.0 (navigation device backend)',
        'Accept': 'application/json'
      },
      body: 'data=' + encodeURIComponent(query),
      // Hard cap: nearby roads are cosmetic context. Never let a slow Overpass
      // response block route delivery — abort and try the next mirror.
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // A rate-limited or overloaded instance answers 200 with an XML/HTML error
    // body, so parse defensively rather than letting JSON.parse throw something
    // unrelated ("Unexpected token '<'").
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) {
      throw new Error('non-JSON response (rate limited or query timeout)');
    }
    const data = JSON.parse(text);

    const roads = [];
    for (const el of data.elements || []) {
      if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
      const poly = el.geometry.map((g) => [g.lon, g.lat]);
      if (poly.length >= 2) roads.push(poly);
    }
    return roads;
  }

  // ===== Utilities =====

  maneuverToDirection(maneuver) {
    if (!maneuver) return 'S';
    const m = maneuver.toLowerCase();
    // U-turn MUST be tested first: Google emits "uturn-left" / "uturn-right",
    // and a plain `includes('right')` test classified "uturn-right" as a normal
    // right turn, so the display showed a right arrow for a U-turn.
    if (m.includes('uturn') || m.includes('u-turn')) return 'U';
    if (m.includes('right')) return 'R';
    if (m.includes('left')) return 'L';
    return 'S';
  }

  /**
   * Map an OSRM maneuver object to a direction code (R/L/U/S).
   * OSRM uses `type` (turn/roundabout/fork/...) + `modifier`
   * (left/right/slight left/sharp right/uturn/straight).
   */
  osrmManeuverToDirection(m) {
    if (!m) return 'S';
    const mod = (m.modifier || '').toLowerCase();
    const type = (m.type || '').toLowerCase();
    if (type === 'arrive' || type === 'depart') return 'S';
    if (mod.includes('uturn')) return 'U';
    if (mod.includes('right')) return 'R';
    if (mod.includes('left')) return 'L';
    return 'S';
  }

  /**
   * Build a short instruction string from an OSRM step.
   */
  osrmInstruction(step, m) {
    const type = (m && m.type) || '';
    const mod = (m && m.modifier) || '';
    const road = step && step.name ? step.name : '';
    if (type === 'arrive') return 'Arrive';
    if (type === 'depart') return road ? `Head onto ${road}` : 'Depart';
    if (type === 'roundabout' || type === 'rotary') return 'Enter roundabout';
    if (type === 'exit roundabout' || type === 'exit rotary') {
      return road ? `Exit onto ${road}` : 'Exit roundabout';
    }
    let verb = 'Continue';
    if (mod.includes('uturn')) verb = 'Make a U-turn';
    else if (mod.includes('right')) verb = mod.includes('slight') ? 'Slight right' : (mod.includes('sharp') ? 'Sharp right' : 'Turn right');
    else if (mod.includes('left')) verb = mod.includes('slight') ? 'Slight left' : (mod.includes('sharp') ? 'Sharp left' : 'Turn left');
    const text = road ? `${verb} onto ${road}` : verb;
    return text.length > 30 ? text.substring(0, 28) + '..' : text;
  }

  cleanInstruction(html) {
    if (!html) return 'Continue';
    const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
    return text.length > 30 ? text.substring(0, 28) + '..' : text;
  }
}

// ===== Geo helpers (module-level, reused by frameRenderer via re-export) =====

/**
 * Decode a Google/OSRM encoded polyline into [[lat,lng], ...].
 */
export function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/**
 * Haversine distance in meters between two [lng,lat] (or lat/lng scalars).
 */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cumulative along-path distance (meters) for a [[lng,lat], ...] polyline.
 */
export function cumulativeDistances(geometry) {
  const cum = [0];
  for (let i = 1; i < geometry.length; i++) {
    const [lng0, lat0] = geometry[i - 1];
    const [lng1, lat1] = geometry[i];
    cum.push(cum[i - 1] + haversine(lat0, lng0, lat1, lng1));
  }
  return cum;
}

/** Interpolated [lng,lat] at along-route distance `d` (clamped to the route). */
export function positionAlong(geometry, cum, d) {
  const total = cum[cum.length - 1];
  if (d <= 0) return geometry[0];
  if (d >= total) return geometry[geometry.length - 1];
  let i = 0;
  while (i < geometry.length - 2 && cum[i + 1] < d) i++;
  const t = (d - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
  return [
    geometry[i][0] + (geometry[i + 1][0] - geometry[i][0]) * t,
    geometry[i][1] + (geometry[i + 1][1] - geometry[i][1]) * t
  ];
}

/**
 * Index of the polyline vertex nearest to (lng,lat). Cheap planar metric.
 */
export function nearestVertexIndex(geometry, lng, lat) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < geometry.length; i++) {
    const dx = geometry[i][0] - lng;
    const dy = geometry[i][1] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Like nearestVertexIndex, but only considers vertices at or after `from`, and
 * returns the FIRST vertex that matches exactly (provider maneuver locations are
 * route vertices). Keeps turn points in travel order on self-crossing routes.
 */
export function nearestVertexIndexFrom(geometry, lng, lat, from = 0) {
  let best = Math.min(Math.max(0, from), geometry.length - 1), bestD = Infinity;
  for (let i = best; i < geometry.length; i++) {
    const dx = geometry[i][0] - lng;
    const dy = geometry[i][1] - lat;
    const d = dx * dx + dy * dy;
    if (d < 1e-14) return i; // exact vertex (sub-centimetre)
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Perpendicular distance (meters) from a [lng,lat] point to a [[lng,lat],...]
 * polyline, in a local planar frame. Accurate for the short spans involved.
 */
function distanceToPolyline(lng, lat, poly) {
  const k = 111320;
  const cosLat = Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const ax = (poly[i][0] - lng) * k * cosLat, ay = (poly[i][1] - lat) * k;
    const bx = (poly[i + 1][0] - lng) * k * cosLat, by = (poly[i + 1][1] - lat) * k;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-9 ? -(ax * dx + ay * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best) best = d;
  }
  return best;
}

/**
 * True when `poly` is (a piece of) the route itself rather than a neighbouring
 * road: most of its vertices sit on top of the route line. The threshold is
 * deliberately tight so a service road running parallel a few metres away is
 * still kept as context.
 */
function isOnRoute(poly, geometry, tolM = 5, coverage = 0.7) {
  if (!geometry || geometry.length < 2) return false;
  // Sample at most 12 vertices — enough to decide, cheap on long ways.
  const stride = Math.max(1, Math.floor(poly.length / 12));
  let n = 0, on = 0;
  for (let i = 0; i < poly.length; i += stride) {
    n++;
    if (distanceToPolyline(poly[i][0], poly[i][1], geometry) <= tolM) on++;
  }
  return n > 0 && on / n >= coverage;
}

/**
 * Build a frameRenderer-compatible route from a raw GPS trail (breadcrumbs).
 *
 * Used by the backtrack features, which navigate the rider back along a path
 * they actually rode rather than a provider route. Two things matter here:
 *
 *  - `direction` MUST be one of the single-letter codes R / L / S / U. The
 *    firmware stores it in `char direction[4]`, so a word like "sharp-right" was
 *    truncated to "sha", matched none of the icon cases and always drew the
 *    straight-ahead arrow.
 *  - `dist` MUST come from the same cumulative-distance array the renderer uses,
 *    otherwise the countdown to each turn disagrees with the rider's position.
 *    The previous inline version accumulated its own approximation that treated
 *    a degree of longitude as a full 111320 m (no cos(lat) factor), so every
 *    turn distance was overstated.
 *
 * @param {Array<{lat:number,lng:number}>} points  trail in travel order
 * @param {{startAddress?:string, endAddress?:string}} [labels]
 * @returns {{geometry:Array, cum:number[], turnPoints:Array, totalDistance:number, roads:Array, summary:Object}}
 */
export function buildTrailRoute(points, labels = {}) {
  const geometry = points.map((p) => [p.lng, p.lat]);
  const cum = cumulativeDistances(geometry);
  const totalDistance = cum[cum.length - 1] || 0;

  // A turn is a heading change over the TURN_WINDOW_DEG threshold at a vertex.
  const TURN_WINDOW_DEG = 35;
  const turnPoints = [];
  for (let i = 1; i < geometry.length - 1; i++) {
    const h1 = trailBearing(geometry[i - 1], geometry[i]);
    const h2 = trailBearing(geometry[i], geometry[i + 1]);
    let diff = h2 - h1;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    if (Math.abs(diff) < TURN_WINDOW_DEG) continue;

    // Positive diff = clockwise = right turn (bearings are clockwise from north).
    let direction, instruction;
    if (Math.abs(diff) > 150) { direction = 'U'; instruction = 'Make a U-turn'; }
    else if (diff > 0) {
      direction = 'R';
      instruction = Math.abs(diff) > 110 ? 'Sharp right' : (Math.abs(diff) < 50 ? 'Slight right' : 'Turn right');
    } else {
      direction = 'L';
      instruction = Math.abs(diff) > 110 ? 'Sharp left' : (Math.abs(diff) < 50 ? 'Slight left' : 'Turn left');
    }
    turnPoints.push({ dist: cum[i], direction, instruction });
  }
  turnPoints.push({ dist: totalDistance, direction: 'S', instruction: 'Arrive' });

  return {
    geometry,
    cum,
    turnPoints,
    totalDistance,
    roads: [], // skip the Overpass fetch so backtrack starts immediately
    summary: {
      distance: totalDistance > 1000
        ? `${(totalDistance / 1000).toFixed(1)} km`
        : `${Math.round(totalDistance)} m`,
      duration: '', // unknown for a replayed trail
      startAddress: labels.startAddress || 'Current location',
      endAddress: labels.endAddress || 'Start point'
    }
  };
}

/** Bearing (deg clockwise from north) between two [lng,lat] points. */
function trailBearing([lng1, lat1], [lng2, lat2]) {
  const dLon = (lng2 - lng1) * Math.PI / 180;
  const r1 = lat1 * Math.PI / 180;
  const r2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(r2);
  const x = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Map-match a GPS fix onto the route polyline.
 *
 * Projects (lat,lng) onto the nearest route segment and returns how far along
 * the route that projection lies, plus the perpendicular off-route distance.
 * Distances are computed in a local planar frame (longitude scaled by cos(lat))
 * which is accurate for the short segments involved.
 *
 * @param {Array} geometry [[lng,lat], ...]
 * @param {number[]} cum   cumulative distances for geometry
 * @param {number} lat
 * @param {number} lng
 * @returns {{ distAlong: number, offMeters: number, segIndex: number }}
 */
export function projectOntoRoute(geometry, cum, lat, lng, hint = null) {
  if (!geometry || geometry.length < 2) {
    return { distAlong: 0, offMeters: Infinity, segIndex: 0 };
  }
  // Windowed match first. A global nearest-segment search snaps the rider onto
  // whichever part of the route is closest, so wherever the route passes near
  // itself (loops, out-and-back legs, the other carriageway of a dual road,
  // a flyover above a road used later) the position jumped hundreds of metres
  // and the display showed the wrong road and the wrong next turn. Searching
  // only near the last known position keeps the match on the current pass; the
  // global search is used only when nothing in the window is close (start of
  // the ride, GPS dropout, rejoining after a detour).
  if (hint && Number.isFinite(hint.distAlong)) {
    const lo = hint.distAlong - (hint.back ?? 40);
    const hi = hint.distAlong + (hint.ahead ?? 250);
    const local = projectRange(geometry, cum, lat, lng, lo, hi);
    if (local.offMeters <= (hint.maxOff ?? 35)) return local;
  }
  return projectRange(geometry, cum, lat, lng, -Infinity, Infinity);
}

function projectRange(geometry, cum, lat, lng, lo, hi) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * cosLat;

  // Point in local meters (origin at the GPS fix itself keeps numbers small).
  const px = 0, py = 0;

  let best = { distAlong: 0, offMeters: Infinity, segIndex: 0 };
  for (let i = 0; i < geometry.length - 1; i++) {
    if (cum[i + 1] < lo || cum[i] > hi) continue;
    const [aLng, aLat] = geometry[i];
    const [bLng, bLat] = geometry[i + 1];
    const ax = (aLng - lng) * mPerDegLng, ay = (aLat - lat) * mPerDegLat;
    const bx = (bLng - lng) * mPerDegLng, by = (bLat - lat) * mPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const segLen2 = dx * dx + dy * dy;
    let t = 0;
    if (segLen2 > 1e-9) {
      t = ((px - ax) * dx + (py - ay) * dy) / segLen2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const cxp = ax + dx * t, cyp = ay + dy * t;
    const off = Math.hypot(cxp - px, cyp - py);
    if (off < best.offMeters) {
      const segLen = cum[i + 1] - cum[i];
      best = {
        distAlong: cum[i] + segLen * t,
        offMeters: off,
        segIndex: i
      };
    }
  }
  return best;
}
