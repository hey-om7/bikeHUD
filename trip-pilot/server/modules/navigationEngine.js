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

// Overpass endpoint + the highway classes worth drawing as gray context roads.
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const HIGHWAY_FILTER =
  '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street|road)$';

export class NavigationEngine {
  constructor() {
    this.client = new Client({});
  }

  /**
   * Generate navigation data from source to destination.
   * Returns raw geographic geometry (see module header) ready for framing.
   *
   * Provider order: Google Directions (primary) -> OSRM (fallback). The route
   * geometry is taken verbatim from whichever provider answers; we never
   * synthesise it. Throws if BOTH providers fail.
   */
  async generateRoute(sourceLat, sourceLng, destLat, destLng) {
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
    try {
      const roads = await this.fetchNearbyRoads(route.geometry);
      route.roads = roads.length ? roads : (route.roads || []);
    } catch (e) {
      console.error('[NAV] Nearby-road fetch failed, route-only view:', e.message);
      route.roads = route.roads || [];
    }

    return route;
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
    for (const step of leg.steps) {
      const pts = decodePolyline(step.polyline.points); // [[lat,lng], ...]
      for (const [lat, lng] of pts) {
        const c = [lng, lat];
        // Avoid duplicate seam points between consecutive steps.
        const last = geometry[geometry.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) geometry.push(c);
      }
    }
    if (geometry.length < 2) {
      geometry = decodePolyline(route.overview_polyline.points).map(([lat, lng]) => [lng, lat]);
    }

    const cum = cumulativeDistances(geometry);
    const totalDistance = cum[cum.length - 1];

    // Turn points: at each step boundary, the maneuver that STARTS the next step.
    const turnPoints = [];
    for (let i = 0; i < leg.steps.length; i++) {
      const step = leg.steps[i];
      const endLat = step.end_location.lat;
      const endLng = step.end_location.lng;
      const idx = nearestVertexIndex(geometry, endLng, endLat);
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
    for (const step of steps) {
      const m = step.maneuver || {};
      const loc = m.location; // [lng, lat]
      if (!loc) continue;
      const idx = nearestVertexIndex(geometry, loc[0], loc[1]);
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

    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass (Apache/mod_security) 406s requests without a normal UA.
        'User-Agent': 'TripPilot/1.0 (navigation device backend)',
        'Accept': 'application/json'
      },
      body: 'data=' + encodeURIComponent(query),
      // Hard cap: nearby roads are cosmetic context. Never let a slow Overpass
      // response block route delivery — abort and fall back to route-only.
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = await res.json();

    const roads = [];
    for (const el of data.elements || []) {
      if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
      const poly = el.geometry.map((g) => [g.lon, g.lat]);
      if (poly.length >= 2) roads.push(poly);
    }
    console.log(`[NAV] Overpass returned ${roads.length} nearby road segments`);
    return roads;
  }

  // ===== Utilities =====

  maneuverToDirection(maneuver) {
    if (!maneuver) return 'S';
    if (maneuver.includes('right')) return 'R';
    if (maneuver.includes('left')) return 'L';
    if (maneuver.includes('uturn') || maneuver.includes('u-turn')) return 'U';
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
