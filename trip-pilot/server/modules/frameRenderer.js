/**
 * frameRenderer.js - turns raw route + road geometry into heading-up,
 * view-culled screen frames for the ESP32 nav display.
 *
 * For a given rider position along the route we build ONE frame that mimics a
 * first-person, direction-of-travel-up camera:
 *   1. Everything is expressed relative to the rider position + heading, so the
 *      road ahead always points UP the screen (heading-up).
 *   2. Local ground coordinates are projected with a proper tilted pinhole
 *      camera (true 1/depth perspective) so straight roads stay straight and
 *      keep a consistent angle as the rider advances.
 *   3. Anything outside the camera frustum is culled — the tiny CPU only ever
 *      receives the handful of line segments actually visible right now.
 *
 * Two public entry points:
 *   - renderFrameAt(route, cum, distAlong, prevHeading) -> ONE frame. Used for
 *     closed-loop rendering keyed to the device's real map-matched position.
 *   - buildFrames(route) -> the full pre-baked frame sequence. Used for the
 *     browser preview and as a dev/offline fallback for the device.
 *
 * Frame payload (a NAV_CHUNK):
 *   { type, mainPath:[[x,y]...], sidePaths:[[[x,y]...]...], sideIds:[id...],
 *     direction, distance, instruction, bearing, progress,
 *     chunkIndex, totalChunks, isLast }
 *
 *   mainPath  -> the active route, drawn PURE WHITE by the device.
 *   sidePaths -> surrounding roads, drawn GRAY by the device.
 *   sideIds   -> stable per-road id (parallel to sidePaths) so the device can
 *                interpolate the SAME physical road between frames.
 */

import { cumulativeDistances, haversine } from './navigationEngine.js';

// ===== Screen constants (must match nav_display.h + config.h) =====
const SCREEN_W = 320;
const SCREEN_H = 240;
const CENTER_X = 160;
const PATH_TOP_Y = 25;   // horizon line: where forward -> infinity projects
const PATH_BOT_Y = 175;  // rider origin: where forward = 0 projects

// ===== Tilted pinhole camera (true perspective) =====
// Screen mapping for a ground point at (right, forward) meters relative to the
// rider (forward > 0 is ahead / up the screen):
//     den = forward + CAM_D0            (depth; >0 everywhere we render)
//     y   = PATH_TOP_Y + CAM_K / den    (forward=0 -> PATH_BOT_Y, inf -> horizon)
//     x   = CENTER_X  + right * CAM_LAT_F / den
// CAM_K and CAM_D0 are chosen so forward=0 -> y=175 and forward=140 -> y~=40.
const CAM_D0    = 15.5;   // camera distance offset (m) -> controls near compression
const CAM_K     = (PATH_BOT_Y - PATH_TOP_Y) * CAM_D0; // = 2325 -> forward 0 hits PATH_BOT_Y
const CAM_LAT_F = 80;     // lateral focal length (px*m) -> horizontal spread/convergence
const CAM_NEAR_DEN = 3;   // near plane: drop anything with den < this (avoids singularity)
const HALF_FOV_RAD = 55 * Math.PI / 180; // ~110 deg horizontal field of view

// ===== View + framing =====
const VIEW_RADIUS_M = 140;   // how far ahead we render (a LOCAL view)
const FRAME_STEP_M = 10;     // distance between pre-baked frames along the route
const MAX_FRAMES = 2000;     // safety cap (uint16 chunk index supports far more)

// ===== Heading smoothing =====
const HEAD_BACK_M = 8;       // look-behind distance for the tangent
const HEAD_AHEAD_M = 32;     // look-ahead distance for the tangent
const HEAD_EMA_ALPHA = 0.4;  // circular EMA weight for the new heading (0..1)

// ===== Device buffer limits (must match server_connection.h on the ESP32) =====
const MAX_MAIN_PATH_POINTS = 96;
const MAX_SIDE_PATHS = 10;
const MAX_SIDE_PATH_POINTS = 12;

// Max ground length (m) of a road segment before we interpolate extra points,
// so a road crossing the small view window is actually sampled.
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
 * Interpolate the [lng,lat] position at along-route distance `d`.
 */
function positionAtDistance(geometry, cum, d) {
  const total = cum[cum.length - 1];
  if (d <= 0) return geometry[0];
  if (d >= total) return geometry[geometry.length - 1];
  let seg = 0;
  while (seg < geometry.length - 2 && cum[seg + 1] < d) seg++;
  const segLen = cum[seg + 1] - cum[seg] || 1;
  const ratio = Math.min(1, Math.max(0, (d - cum[seg]) / segLen));
  const [lngA, latA] = geometry[seg];
  const [lngB, latB] = geometry[seg + 1];
  return [lngA + (lngB - lngA) * ratio, latA + (latB - latA) * ratio];
}

/**
 * Smoothed direction-of-travel at distance `d`: the bearing from a point a
 * little behind the rider to a point well ahead. Averaging over a ~40 m window
 * removes the per-vertex digitization noise that made the whole scene snap-
 * rotate frame to frame. Returns degrees.
 */
function headingAt(geometry, cum, d) {
  const total = cum[cum.length - 1];
  const back = positionAtDistance(geometry, cum, Math.max(0, d - HEAD_BACK_M));
  const ahead = positionAtDistance(geometry, cum, Math.min(total, d + HEAD_AHEAD_M));
  // back/ahead are [lng,lat]
  if (back[0] === ahead[0] && back[1] === ahead[1]) {
    // Degenerate (route shorter than the window) — fall back to local segment.
    const a = positionAtDistance(geometry, cum, Math.max(0, d - 1));
    const b = positionAtDistance(geometry, cum, Math.min(total, d + 1));
    return bearing(a[1], a[0], b[1], b[0]);
  }
  return bearing(back[1], back[0], ahead[1], ahead[0]);
}

/**
 * Circular exponential moving average of a heading (degrees). Blends on the
 * unit circle so the 359deg -> 1deg wrap is handled correctly.
 */
function emaHeading(prevDeg, nextDeg, alpha) {
  if (prevDeg == null || Number.isNaN(prevDeg)) return nextDeg;
  const pr = prevDeg * Math.PI / 180;
  const nx = nextDeg * Math.PI / 180;
  const sx = alpha * Math.sin(nx) + (1 - alpha) * Math.sin(pr);
  const sy = alpha * Math.cos(nx) + (1 - alpha) * Math.cos(pr);
  return (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
}

/**
 * Project a geographic point into screen space relative to the rider using a
 * tilted pinhole camera. Returns { x, y, forward, right, visible }.
 * `visible` is false if the point is behind the near plane or outside the
 * horizontal field of view.
 */
function project(lat0, lng0, headingDeg, lat, lng) {
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  const north = (lat - lat0) * 111320;
  const east = (lng - lng0) * 111320 * cosLat;

  const h = headingDeg * Math.PI / 180;
  const sinH = Math.sin(h), cosH = Math.cos(h);
  const forward = east * sinH + north * cosH;
  const right = east * cosH - north * sinH;

  const den = forward + CAM_D0;

  let visible = true;
  if (den < CAM_NEAR_DEN) visible = false;
  // Frustum: cull by horizontal angle rather than a lateral box, so roads far
  // abeam of a forward-facing camera are not drawn sweeping across the bottom.
  const ang = Math.atan2(right, Math.max(forward, 0.001));
  if (Math.abs(ang) > HALF_FOV_RAD) visible = false;

  const x = CENTER_X + (right * CAM_LAT_F) / den;
  const y = PATH_TOP_Y + CAM_K / den;

  return { x, y, forward, right, visible };
}

function onScreen(x, y) {
  return x >= -40 && x <= SCREEN_W + 40 && y >= PATH_TOP_Y - 10 && y <= SCREEN_H + 20;
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
  if (!last) { arr.push([x, y]); return; }
  const dx = x - last[0];
  const dy = y - last[1];
  if ((dx * dx + dy * dy) < 0.25) return; // drop sub-pixel duplicates
  arr.push([Math.round(x), Math.round(y)]);
}

/**
 * Densify a [[lng,lat], ...] polyline so no segment exceeds DENSIFY_M meters.
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
 * route from the rider to VIEW_RADIUS_M ahead, projected + culled.
 */
function buildMainPath(geometry, cum, anchorDist, lat0, lng0, heading) {
  const from = anchorDist - 2;              // tiny tail so the stroke starts at the rider
  const to = anchorDist + VIEW_RADIUS_M;

  const window = [];
  for (let i = 0; i < geometry.length; i++) {
    if (cum[i] < from) { if (cum[i + 1] !== undefined && cum[i + 1] >= from) window.push(geometry[i]); continue; }
    if (cum[i] > to) { window.push(geometry[i]); break; }
    window.push(geometry[i]);
  }

  const pts = [];
  for (const [lng, lat] of densify(window)) {
    const p = project(lat0, lng0, heading, lat, lng);
    if (!p.visible) continue;
    pushDedup(pts, p.x, p.y);
  }
  return cap(pts, MAX_MAIN_PATH_POINTS);
}

/**
 * Build gray surrounding-road polylines. Each road (identified by its stable
 * index in the route.roads array) contributes at most ONE visible polyline,
 * tagged with that index as `id`. Keeping one run per road with a stable id
 * lets the device interpolate the same physical road between frames instead of
 * morphing unrelated roads into each other.
 *
 * Returns { paths: [[[x,y]...]...], ids: [id...] }, closest roads first.
 */
function buildSidePaths(roads, lat0, lng0, heading) {
  const runs = [];
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri];
    // Collect the single best (closest) contiguous visible run for this road.
    let cur = [];
    let curScore = Infinity;
    let best = null; // { pts, score }
    const flush = () => {
      if (cur.length >= 2 && curScore < (best ? best.score : Infinity)) {
        best = { pts: cap(cur, MAX_SIDE_PATH_POINTS), score: curScore };
      }
      cur = [];
      curScore = Infinity;
    };
    for (const [lng, lat] of densify(road)) {
      const p = project(lat0, lng0, heading, lat, lng);
      if (p.visible && onScreen(p.x, p.y)) {
        pushDedup(cur, p.x, p.y);
        const score = Math.abs(p.forward) + Math.abs(p.right);
        if (score < curScore) curScore = score;
      } else {
        flush();
      }
    }
    flush();
    if (best) runs.push({ pts: best.pts, score: best.score, id: ri });
  }
  runs.sort((a, b) => a.score - b.score); // nearest roads first
  const picked = runs.slice(0, MAX_SIDE_PATHS);
  return {
    paths: picked.map((r) => r.pts),
    ids: picked.map((r) => r.id)
  };
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
 * Render ONE frame at along-route distance `distAlong`.
 *
 * @param {Object} route    { geometry, roads, turnPoints }
 * @param {number[]} cum     cumulative distances for route.geometry
 * @param {number} distAlong along-route distance of the rider (meters)
 * @param {number|null} prevHeading  last smoothed heading (deg) for temporal EMA
 * @returns {{ frame: Object, heading: number }}
 */
export function renderFrameAt(route, cum, distAlong, prevHeading = null) {
  const geometry = route.geometry || [];
  const roads = route.roads || [];
  const turnPoints = route.turnPoints || [];
  const total = cum[cum.length - 1] || 0;
  const d = Math.min(Math.max(0, distAlong), total);

  const [lng0, lat0] = positionAtDistance(geometry, cum, d);

  // Spatially-smoothed tangent, then temporally-smoothed on the unit circle.
  const rawHeading = headingAt(geometry, cum, d);
  const heading = emaHeading(prevHeading, rawHeading, HEAD_EMA_ALPHA);

  const mainPath = buildMainPath(geometry, cum, d, lat0, lng0, heading);
  const side = buildSidePaths(roads, lat0, lng0, heading);
  const turn = turnInfoAt(turnPoints, d);

  const frame = {
    type: 'NAV_CHUNK',
    mainPath,
    sidePaths: side.paths,
    sideIds: side.ids,
    direction: turn.direction,
    distance: turn.distance,
    instruction: turn.instruction,
    bearing: Math.round(heading),
    progress: total > 0 ? d / total : 0,
    chunkIndex: 0,
    totalChunks: 1,
    isLast: total > 0 && d >= total - 1
  };
  return { frame, heading };
}

/**
 * Sample the whole route into a sequence of renderable frames (pre-baked).
 * Used for the browser preview and as a dev/offline fallback on the device.
 * @param {Object} route { geometry, roads, turnPoints, totalDistance }
 * @returns {Array} frames (NAV_CHUNK payloads)
 */
export function buildFrames(route) {
  const geometry = route.geometry || [];
  if (geometry.length < 2) return [];

  const cum = cumulativeDistances(geometry);
  const total = cum[cum.length - 1];

  // Keep the sample step fixed so the origin never leaps between frames; cap
  // the count only as a hard safety limit (uint16 chunk index has huge range).
  let step = FRAME_STEP_M;
  if (total / step > MAX_FRAMES) step = total / MAX_FRAMES;

  const anchors = [];
  for (let d = 0; d < total; d += step) anchors.push(d);
  anchors.push(total);

  const frames = [];
  let prevHeading = null;
  for (const d of anchors) {
    const { frame, heading } = renderFrameAt(route, cum, d, prevHeading);
    prevHeading = heading;
    frame.chunkIndex = frames.length;
    frame.isLast = false;
    frames.push(frame);
  }

  if (frames.length) {
    const lastFrame = frames[frames.length - 1];
    lastFrame.isLast = true;
    lastFrame.direction = 'S';
    lastFrame.distance = 0;
    lastFrame.instruction = 'Arrive';
  }
  for (const f of frames) f.totalChunks = frames.length;

  return frames;
}
