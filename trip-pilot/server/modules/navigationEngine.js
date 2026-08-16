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
 * Route source: Google Directions (if GOOGLE_MAPS_API_KEY set), else a mock.
 * Nearby roads: OpenStreetMap Overpass API `way(around:...)` along the route
 *               (no key needed, bounded to a thin corridor around the path).
 */

import { Client } from '@googlemaps/google-maps-services-js';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

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
   */
  async generateRoute(sourceLat, sourceLng, destLat, destLng) {
    let route;
    if (GOOGLE_MAPS_API_KEY) {
      try {
        route = await this.generateGoogleRoute(sourceLat, sourceLng, destLat, destLng);
      } catch (e) {
        console.error('[NAV] Google Maps API error, falling back to mock:', e.message);
      }
    }
    if (!route) {
      route = this.generateMockRoute(sourceLat, sourceLng, destLat, destLng);
    }

    // Fetch surrounding roads for the gray context layer (best-effort).
    // Real OSM roads win; fall back to any synthetic/mock roads, then to none.
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
   * Mock route (no API key): a gently bending path plus a handful of synthetic
   * cross/parallel roads so the framing pipeline has something to render.
   */
  generateMockRoute(srcLat, srcLng, dstLat, dstLng) {
    const N = 60;
    const geometry = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      // Base interpolation + a couple of sine bends for visual interest.
      const lat = srcLat + (dstLat - srcLat) * t + Math.sin(t * Math.PI * 3) * 0.0008;
      const lng = srcLng + (dstLng - srcLng) * t + Math.sin(t * Math.PI * 2) * 0.0010;
      geometry.push([lng, lat]);
    }

    const cum = cumulativeDistances(geometry);
    const totalDistance = cum[cum.length - 1];

    // Synthetic surrounding roads: cross streets every few vertices + one parallel.
    const roads = [];
    for (let i = 6; i < geometry.length - 6; i += 8) {
      const [lng, lat] = geometry[i];
      // Perpendicular-ish cross street.
      roads.push([
        [lng - 0.0016, lat + 0.0010],
        [lng, lat],
        [lng + 0.0016, lat - 0.0010]
      ]);
    }
    const parallel = geometry.filter((_, i) => i % 3 === 0).map(([lng, lat]) => [lng + 0.0012, lat + 0.0009]);
    if (parallel.length >= 2) roads.push(parallel);

    const turnPoints = [
      { dist: totalDistance * 0.33, direction: 'R', instruction: 'Turn right' },
      { dist: totalDistance * 0.66, direction: 'L', instruction: 'Turn left' },
      { dist: totalDistance, direction: 'S', instruction: 'Arrive' }
    ];

    return {
      geometry,
      roads, // mock supplies its own; generateRoute won't overwrite (see below)
      turnPoints,
      totalDistance,
      summary: {
        distance: totalDistance > 1000 ? `${(totalDistance / 1000).toFixed(1)} km` : `${Math.round(totalDistance)} m`,
        duration: `${Math.max(1, Math.round(totalDistance / 400))} min`,
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
      body: 'data=' + encodeURIComponent(query)
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
