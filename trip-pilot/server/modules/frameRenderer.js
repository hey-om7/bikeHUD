/**
 * frameRenderer.js - turns raw route + road geometry into heading-up,
 * view-culled screen frames for the ESP32 nav display (the sim.html look).
 *
 * For each sampled position along the route we build ONE frame that mimics a
 * first-person, north-of-travel-up camera:
 *   1. Everything is expressed relative to the rider position + heading, so the
 *      road ahead always points UP the screen.
 *   2. Local ground coordinates are projected with the same perspective model
 *      the firmware uses (narrowing toward a vanishing point near the top).
 *   3. Anything outside a small view radius is culled — the tiny CPU only ever
 *      receives the handful of line segments actually visible right now.
 *
 * Output per frame (a NAV_CHUNK payload):
 *   { type, mainPath:[[x,y]...], sidePaths:[[[x,y]...]...],
 *     direction, distance, instruction, bearing, chunkIndex, totalChunks, isLast }
 *
 *   mainPath  -> the active route, drawn PURE WHITE by the device.
 *   sidePaths -> surrounding roads, drawn GRAY by the device.
 */

import { cumulativeDistances, haversine } from './navigationEngine.js';

// ===== Screen / camera constants (must match nav_display.h + config.h) =====
const SCREEN_W = 320;
const SCREEN_H = 240;
const CENTER_X = 160;
const PATH_TOP_Y = 25;   // vanishing point Y
const PATH_BOT_Y = 175;  // rider / path origin Y
const PERSPECTIVE_NARROW = 0.65; // lateral narrowing at the horizon (matches firmware)

// ===== View + framing =====
const VIEW_RADIUS_M = 140;   // how far ahead we render (keeps it a LOCAL view)
const BEHIND_M = 18;         // small tail behind the rider so the line enters from below
const FRAME_STEP_M = 10;     // distance between sampled frames along the route
const MAX_FRAMES = 400;      // hard cap so long routes don't explode memory

// ===== Device buffer limits (must match server_connection.h on the ESP32) =====
const MAX_MAIN_PATH_POINTS = 96;
const MAX_SIDE_PATHS = 10;
const MAX_SIDE_PATH_POINTS = 12;

const PX_PER_M = (PATH_BOT_Y - PATH_TOP_Y) / VIEW_RADIUS_M;

// Max ground length (m) of a road segment before we interpolate extra points.
// OSM ways can place two nodes hundreds of meters apart on a straight road; we
// densify so the portion crossing our small view window is actually sampled.
const DENSIFY_M = 4;

// ---- Geo helpers ----

function bearing(lat1, lng1, lat2, lng2) {
  const dLon = (lng2 - lng1) * Math.PI / 180;
  const rlat1 = lat1 * Math.PI / 180;
  const rlat2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(rlat2);
  const x = Math.cos(rlat1) * Math.sin(rlat2) - Math.sin(rlat1) * Math.cos(rlat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Project a geographic point into screen space relative to the rider.
 * Returns { x, y, forward, right } where forward/right are meters used for
 * culling. `forward` > 0 is ahead of the rider (up the screen).
 */
function project(lat0, lng0, headingDeg, lat, lng) {
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  const north = (lat - lat0) * 111320;
  const east = (lng - lng0) * 111320 * cosLat;

  const h = headingDeg * Math.PI / 180;
  const sinH = Math.sin(h), cosH = Math.cos(h);
  const forward = east * sinH + north * cosH;
  const right = east * cosH - north * sinH;

  // Linear ground->screen, then perspective narrowing toward the vanishing point.
  const preX = CENTER_X + right * PX_PER_M;
  const preY = PATH_BOT_Y - forward * PX_PER_M;

  let t = (PATH_BOT_Y - preY) / (PATH_BOT_Y - PATH_TOP_Y);
  if (t < 0) t = 0; if (t > 1) t = 1;
  const pf = 1 - t * PERSPECTIVE_NARROW;
  const x = CENTER_X + (preX - CENTER_X) * pf;

  const y = preY;

  return { x, y, forward, right };
}

function forwardInView(forward) {
  return forward >= -(BEHIND_M + 6) && forward <= VIEW_RADIUS_M + 12;
}

function onScreen(x, y) {
  return x >= -30 && x <= SCREEN_W + 30 && y >= PATH_TOP_Y - 20 && y <= SCREEN_H + 10;
}

/**
 * Uniformly decimate a polyline to at most `max` points, keeping endpoints.
 */
function cap(points, max) {
  if (points.length <= max) return points;
  const out = [];
  const stride = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]);
  return out;
}

function pushDedup(arr, x, y) {
  const last = arr[arr.length - 1];

  if (!last) {
    arr.push([x, y]);
    return;
  }

  const dx = x - last[0];
  const dy = y - last[1];

  // Remove only truly redundant points.
  if ((dx * dx + dy * dy) < 0.04) {
    return;
  }

  arr.push([x, y]);
}

/**
 * Densify a [[lng,lat], ...] polyline so no segment exceeds DENSIFY_M meters.
 * Ensures long straight OSM segments get intermediate points to sample.
 */
function densify(poly) {
  if (poly.length < 2) return poly.slice();
  const out = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const [lng0, lat0] = poly[i - 1];
    const [lng1, lat1] = poly[i];
    const d = haversine(lat0, lng0, lat1, lng1);
    const n = Math.max(1, Math.ceil(d / DENSIFY_M));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      out.push([lng0 + (lng1 - lng0) * t, lat0 + (lat1 - lat0) * t]);
    }
  }
  return out;
}

// ---- Per-frame builders ----

/**
 * Build the white route polyline visible from this anchor: the stretch of the
 * route from a little behind the rider to VIEW_RADIUS_M ahead, projected + culled.
 */
function buildMainPath(geometry, cum, anchorDist, lat0, lng0, heading) {
  const from = anchorDist - BEHIND_M;
  const to = anchorDist + VIEW_RADIUS_M;

  // Extract the window sub-polyline (one vertex of padding each side so the
  // stroke reaches the window edges), then densify + project + cull.
  const window = [];
  for (let i = 0; i < geometry.length; i++) {
    if (cum[i] < from) { if (cum[i + 1] !== undefined && cum[i + 1] >= from) window.push(geometry[i]); continue; }
    if (cum[i] > to) { window.push(geometry[i]); break; }
    window.push(geometry[i]);
  }

  const pts = [];
  for (const [lng, lat] of densify(window)) {
    const p = project(lat0, lng0, heading, lat, lng);
    if (!forwardInView(p.forward)) continue;
    pushDedup(pts, p.x, p.y);
  }
  return cap(pts, MAX_MAIN_PATH_POINTS);
}

/**
 * Build gray surrounding-road polylines. Each road is projected and split into
 * runs of consecutive on-screen points; the closest runs (up to MAX_SIDE_PATHS)
 * are kept so we send only the roads actually in view.
 */
function buildSidePaths(roads, lat0, lng0, heading) {
  const runs = [];
  for (const road of roads) {
    let cur = [];
    let bestScore = Infinity;
    const flush = () => {
      if (cur.length >= 2) runs.push({ pts: cap(cur, MAX_SIDE_PATH_POINTS), score: bestScore });
      cur = [];
      bestScore = Infinity;
    };
    for (const [lng, lat] of densify(road)) {
      const p = project(lat0, lng0, heading, lat, lng);
      const visible = forwardInView(p.forward) && Math.abs(p.right) <= VIEW_RADIUS_M * 1.15 && onScreen(p.x, p.y);
      if (visible) {
        pushDedup(cur, p.x, p.y);
        const score = Math.abs(p.forward) + Math.abs(p.right);
        if (score < bestScore) bestScore = score;
      } else {
        flush();
      }
    }
    flush();
  }
  runs.sort((a, b) => a.score - b.score); // nearest roads first
  return runs.slice(0, MAX_SIDE_PATHS).map((r) => r.pts);
}

function turnInfoAt(turnPoints, dist) {
  for (const tp of turnPoints) {
    if (tp.dist >= dist - 1) {
      return {
        direction: tp.direction || 'S',
        distance: Math.max(0, Math.round(tp.dist - dist)),
        instruction: tp.instruction || 'Continue'
      };
    }
  }
  const last = turnPoints[turnPoints.length - 1] || {};
  return { direction: last.direction || 'S', distance: 0, instruction: last.instruction || 'Arrive' };
}

/**
 * Main entry point: sample the route into a sequence of renderable frames.
 * @param {Object} route { geometry, roads, turnPoints, totalDistance }
 * @returns {Array} frames (NAV_CHUNK payloads)
 */
export function buildFrames(route) {
  const geometry = route.geometry || [];
  const roads = route.roads || [];
  const turnPoints = route.turnPoints || [];
  if (geometry.length < 2) return [];

  const cum = cumulativeDistances(geometry);
  const total = cum[cum.length - 1];

  // Frame anchor distances (widen the step if the route is very long).
  let step = FRAME_STEP_M;
  if (total / step > MAX_FRAMES) step = total / MAX_FRAMES;

  const anchors = [];
  for (let d = 0; d < total; d += step) anchors.push(d);
  anchors.push(total);

  const frames = [];
  let seg = 0;
  for (const d of anchors) {
    // Locate the geometry segment containing distance d.
    while (seg < geometry.length - 2 && cum[seg + 1] < d) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const ratio = Math.min(1, Math.max(0, (d - cum[seg]) / segLen));
    const [lngA, latA] = geometry[seg];
    const [lngB, latB] = geometry[seg + 1];
    const lat0 = latA + (latB - latA) * ratio;
    const lng0 = lngA + (lngB - lngA) * ratio;
    const heading = bearing(latA, lngA, latB, lngB);

    const mainPath = buildMainPath(geometry, cum, d, lat0, lng0, heading);
    const sidePaths = buildSidePaths(roads, lat0, lng0, heading);
    const turn = turnInfoAt(turnPoints, d);

    frames.push({
      type: 'NAV_CHUNK',
      mainPath,
      sidePaths,
      direction: turn.direction,
      distance: turn.distance,
      instruction: turn.instruction,
      bearing: Math.round(heading),
      progress: total > 0 ? d / total : 0,
      chunkIndex: frames.length,
      totalChunks: anchors.length,
      isLast: false
    });
  }

  if (frames.length) {
    const lastFrame = frames[frames.length - 1];
    lastFrame.isLast = true;
    lastFrame.direction = 'S';
    lastFrame.distance = 0;
    lastFrame.instruction = 'Arrive';
  }
  // totalChunks reflects the real emitted count.
  for (const f of frames) f.totalChunks = frames.length;

  return frames;
}
