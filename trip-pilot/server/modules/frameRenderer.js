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
 *   3. Geometry is clipped at the near plane (the rider) and culled at the
 *      screen edges, so the tiny CPU only ever receives the handful of line
 *      segments actually visible right now.
 *   4. Every polyline is resampled to a FIXED point count so the device can
 *      linearly interpolate point-by-point between two consecutive frames.
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
// The panel is 320x240. PATH_BOT_Y / PATH_TOP_Y bracket the drivable band: the
// projection below maps forward >= 0 into y in [PATH_TOP_Y, PATH_BOT_Y], so no
// vertical clipping against the panel height is ever needed.
const SCREEN_W = 320;
const CENTER_X = 160;
const PATH_TOP_Y = 25;   // horizon line: where forward -> infinity projects
const PATH_BOT_Y = 175;  // rider origin: where forward = 0 projects

// ===== Tilted pinhole camera (true perspective) =====
// Screen mapping for a ground point at (right, forward) meters relative to the
// rider (forward > 0 is ahead / up the screen):
//     den = forward + CAM_D0            (depth; >= CAM_D0 everywhere we render)
//     y   = PATH_TOP_Y + CAM_K / den    (forward=0 -> PATH_BOT_Y, inf -> horizon)
//     x   = CENTER_X  + right * CAM_LAT_F / den
//
// This is a projective map of the ground plane, so straight roads project to
// straight lines for ANY choice of the three constants; they only control how
// depth is distributed across the panel.
//
// CAM_D0 is what sets that distribution, and it is the difference between a
// readable map and an unreadable one. At CAM_D0 = 15.5 the first 12 m of road
// filled half the panel height and everything past ~50 m was squeezed into the
// top 15 px, so upcoming turns were an unreadable smear along the horizon.
// CAM_D0 = 32 spreads the useful range out instead:
//     forward   0 m -> y 175   (under the chevron)
//              25 m -> y 111   (mid panel)
//             100 m -> y  61
//             140 m -> y  53
// CAM_LAT_F is then chosen to match: 160 px/m at the near plane gives a ~89 deg
// horizontal field of view, so lateral offsets read at a natural scale instead
// of the fisheye-flat spread the old 80 produced.
const CAM_D0    = 32;     // camera distance offset (m) -> depth distribution
const CAM_K     = (PATH_BOT_Y - PATH_TOP_Y) * CAM_D0; // forward 0 hits PATH_BOT_Y
const CAM_LAT_F = 160;    // lateral focal length (px*m) -> horizontal spread

// Near plane, in FORWARD meters (not in `den`). The rider sits at forward = 0,
// which projects exactly to (CENTER_X, PATH_BOT_Y).
//
// This MUST be clamped at the rider. `den` stays positive for forward down to
// -CAM_D0, so a naive `den > small` test happily projects points BEHIND the
// rider — and they land far below the screen (forward = -8 m projects to
// y = 335 on a 240 px panel). That was the single biggest rendering defect:
// the white route stroke started off the bottom of the panel and its start
// point jumped by hundreds of pixels between frames.
const NEAR_FORWARD_M = 0;

// Horizontal cull margin (px). Anything whose projected x falls outside
// [-X_MARGIN, SCREEN_W + X_MARGIN] cannot be seen, so it is dropped. Culling on
// the projected x (rather than on a fixed view angle) means we never throw away
// geometry that is genuinely on screen — the old 55 deg angular frustum clipped
// the road immediately after a sharp turn even though it projected to x = 72.
const X_MARGIN = 40;

// ===== View + framing =====
const VIEW_RADIUS_M = 140;   // how far ahead we render (a LOCAL view)
const FRAME_STEP_M = 10;     // distance between pre-baked frames along the route
const MAX_FRAMES = 2000;     // safety cap (uint16 chunk index supports far more)

// ===== Heading smoothing =====
const HEAD_BACK_M = 8;       // look-behind distance for the tangent
const HEAD_AHEAD_M = 32;     // look-ahead distance for the tangent
const HEAD_EMA_ALPHA = 0.4;  // circular EMA weight for the new heading (0..1)
// Hard limit on how far the smoothed heading may deviate from the road
// IMMEDIATELY ahead. Smoothing over a ~40 m window is what keeps the scene from
// snap-rotating vertex to vertex, but at a U-turn or hairpin the window average
// can end up pointing away from the road the rider is actually about to take.
// The near plane then clips that road away and the white stroke detaches from
// the chevron. Clamping to the immediate tangent keeps the road ahead in front
// of the camera while leaving normal riding fully smoothed.
const HEAD_MAX_DEV_DEG = 60;
const HEAD_IMMEDIATE_M = 12; // look-ahead used for the immediate tangent

// ===== Device buffer limits (must match server_connection.h on the ESP32) =====
const MAX_MAIN_PATH_POINTS = 96;
const MAX_SIDE_PATHS = 10;
const MAX_SIDE_PATH_POINTS = 12;

// Fixed point counts actually emitted. Every frame carries EXACTLY this many
// points per polyline (when the polyline is visible at all), evenly spaced by
// screen arc length. The device lerps frame A -> frame B index by index, so a
// fixed, arc-length parameterisation is what makes index i mean "the same
// fraction along the visible stroke" in both frames. With variable counts the
// same index referred to different ground positions in A and B and the road
// appeared to slide/wobble sideways instead of advancing.
const MAIN_PATH_POINTS = 64;   // <= MAX_MAIN_PATH_POINTS
const SIDE_PATH_POINTS = 8;    // <= MAX_SIDE_PATH_POINTS

// Sub-pixel output. Coordinates are sent as integers in 1/SUBPX pixel units
// (the frame carries `subpx` so the device and preview know the scale). Whole-
// pixel rounding on the server was a main source of the jagged, kinked stroke:
// near the horizon successive points differ by 1-2 px, so rounding turned a
// smooth curve into a staircase, and the device's per-frame lerp then made
// those steps shimmer. 1/4 px keeps values well inside int16.
export const SUBPX = 4;
const COORD_LIMIT = 8000; // clamp (in sub-px units) so int16 can never overflow

// Light corner rounding for the white route, in ground metres. Provider
// polylines are piecewise-linear; at the display's scale their vertices show as
// hard kinks. Two Chaikin passes over the <= DENSIFY_M densified line round a
// corner over ~1-2 m of road, which reads as a smooth vector curve without
// moving the road anywhere it isn't.
const CHAIKIN_PASSES = 2;

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

/** Signed shortest angular difference a -> b, in degrees (-180..180]. */
function angleDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Pull `deg` to within `maxDev` degrees of `ref`. */
function clampToward(deg, ref, maxDev) {
  const d = angleDelta(ref, deg);
  if (Math.abs(d) <= maxDev) return deg;
  return (ref + Math.sign(d) * maxDev + 360) % 360;
}

/**
 * The camera heading to use at along-route distance `d`: the smoothed tangent,
 * temporally damped, then clamped to the road immediately ahead.
 */
function cameraHeadingAt(geometry, cum, d, prevHeading) {
  const total = cum[cum.length - 1];
  const smoothed = emaHeading(prevHeading, headingAt(geometry, cum, d), HEAD_EMA_ALPHA);

  const here = positionAtDistance(geometry, cum, d);
  const soon = positionAtDistance(geometry, cum, Math.min(total, d + HEAD_IMMEDIATE_M));
  if (here[0] === soon[0] && here[1] === soon[1]) return smoothed; // at the destination
  const immediate = bearing(here[1], here[0], soon[1], soon[0]);

  return clampToward(smoothed, immediate, HEAD_MAX_DEV_DEG);
}

// ---- Camera ----

/**
 * Build the rider-local frame for one anchor: origin at (lat0,lng0), +forward
 * along `headingDeg`, +right 90 deg clockwise from it.
 */
function makeCamera(lat0, lng0, headingDeg) {
  const h = headingDeg * Math.PI / 180;
  return {
    lat0, lng0,
    sinH: Math.sin(h),
    cosH: Math.cos(h),
    cosLat0: Math.cos(lat0 * Math.PI / 180)
  };
}

/** Geographic point -> rider-local ground meters { forward, right }. */
function toLocal(cam, lat, lng) {
  const north = (lat - cam.lat0) * 111320;
  const east = (lng - cam.lng0) * 111320 * cam.cosLat0;
  return {
    forward: east * cam.sinH + north * cam.cosH,
    right: east * cam.cosH - north * cam.sinH
  };
}

/** Rider-local ground meters -> screen pixels (tilted pinhole). */
function projectLocal(forward, right) {
  const den = forward + CAM_D0;   // >= CAM_D0 because forward >= NEAR_FORWARD_M
  return {
    x: CENTER_X + (right * CAM_LAT_F) / den,
    y: PATH_TOP_Y + CAM_K / den
  };
}

/**
 * Where a segment crosses the near plane, in local coordinates. Used so a road
 * that runs past the rider terminates exactly on the rider line instead of
 * being truncated at densify granularity (or, worse, wrapping off-screen).
 */
function crossNearPlane(a, b) {
  const span = b.forward - a.forward;
  if (Math.abs(span) < 1e-9) return null;
  const t = (NEAR_FORWARD_M - a.forward) / span;
  if (t < 0 || t > 1) return null;
  return { forward: NEAR_FORWARD_M, right: a.right + (b.right - a.right) * t };
}

function pushDedup(arr, x, y) {
  const last = arr[arr.length - 1];
  if (last && Math.abs(last[0] - x) < 0.25 && Math.abs(last[1] - y) < 0.25) return;
  arr.push([x, y]);
}

/** Float screen px -> clamped integer sub-px units for the wire format. */
function toSubpx(v) {
  const q = Math.round(v * SUBPX);
  return q < -COORD_LIMIT ? -COORD_LIMIT : (q > COORD_LIMIT ? COORD_LIMIT : q);
}

/**
 * Project a [[lng,lat], ...] polyline into visible screen-space runs.
 *
 * Pipeline: geographic -> rider-local ground -> clip at the near plane ->
 * project -> split wherever the line leaves the horizontal frustum.
 *
 * @returns {Array<{pts: Array<[number,number]>, score: number}>}
 *   `score` is the closest ground distance reached by that run (used to rank
 *   surrounding roads by proximity).
 */
function projectPolyline(poly, cam) {
  const local = new Array(poly.length);
  for (let i = 0; i < poly.length; i++) {
    local[i] = toLocal(cam, poly[i][1], poly[i][0]);
  }

  // --- 1. Clip against forward >= NEAR_FORWARD_M, keeping runs contiguous ---
  const clipped = [];
  let run = null;
  for (let i = 0; i < local.length; i++) {
    const p = local[i];
    if (p.forward >= NEAR_FORWARD_M) {
      if (!run) {
        run = [];
        if (i > 0) {
          const c = crossNearPlane(local[i - 1], p);
          if (c) run.push(c);
        }
      }
      run.push(p);
    } else if (run) {
      const c = crossNearPlane(local[i - 1], p);
      if (c) run.push(c);
      clipped.push(run);
      run = null;
    }
  }
  if (run) clipped.push(run);

  // --- 2. Project, and split on horizontal frustum exit ---
  const out = [];
  for (const r of clipped) {
    let pts = [];
    let score = Infinity;
    const flush = () => {
      if (pts.length >= 2) out.push({ pts, score });
      pts = [];
      score = Infinity;
    };
    for (const p of r) {
      const s = projectLocal(p.forward, p.right);
      if (s.x < -X_MARGIN || s.x > SCREEN_W + X_MARGIN) { flush(); continue; }
      pushDedup(pts, s.x, s.y);
      const d = Math.hypot(p.forward, p.right);
      if (d < score) score = d;
    }
    flush();
  }
  return out;
}

/**
 * Resample a screen-space polyline to EXACTLY `n` points, evenly spaced by
 * screen arc length, endpoints preserved. See MAIN_PATH_POINTS for why the
 * count has to be fixed.
 */
function resample(pts, n) {
  if (pts.length < 2) return pts.map((p) => [toSubpx(p[0]), toSubpx(p[1])]);
  const cumLen = [0];
  for (let i = 1; i < pts.length; i++) {
    cumLen.push(cumLen[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cumLen[cumLen.length - 1];
  const q = (p) => [toSubpx(p[0]), toSubpx(p[1])];
  // Degenerate (all points coincide): a 2-point stub is enough to draw.
  if (total < 1) return [q(pts[0]), q(pts[pts.length - 1])];

  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < cumLen.length - 2 && cumLen[j + 1] < d) j++;
    const segLen = cumLen[j + 1] - cumLen[j] || 1;
    const t = (d - cumLen[j]) / segLen;
    out.push(q([
      pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t,
      pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t
    ]));
  }
  return out;
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

/** Chaikin corner cutting on rider-local {forward,right} points, endpoints kept. */
function chaikin(pts, passes) {
  let p = pts;
  for (let k = 0; k < passes && p.length > 2; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      out.push({ forward: 0.75 * a.forward + 0.25 * b.forward, right: 0.75 * a.right + 0.25 * b.right });
      out.push({ forward: 0.25 * a.forward + 0.75 * b.forward, right: 0.25 * a.right + 0.75 * b.right });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/**
 * Build the white route polyline visible from this anchor: the stretch of the
 * route from the rider's exact position to VIEW_RADIUS_M ahead.
 *
 * Sampling is uniform in GROUND distance along the route, not in screen arc
 * length. Point i is always "i * step metres ahead of the rider", so between two
 * consecutive frames index i refers to nearly the same piece of road and the
 * device's point-by-point lerp is a true camera move. With screen-arc sampling
 * the meaning of index i changed whenever the visible length changed (a turn
 * leaving the screen, a curve foreshortening), and the lerp bent and tore the
 * stroke between frames.
 *
 * The main path is NOT culled at the screen edges. The device clips while
 * rasterising, so keeping off-screen points costs nothing and the point count
 * stays fixed; cutting at the edge was what made the stroke end abruptly and
 * pop as the road swung in and out of view. It is cut only where the road goes
 * behind the rider (hairpins), since such points cannot be projected.
 */
function buildMainPath(geometry, cum, anchorDist, cam) {
  const total = cum[cum.length - 1];
  const to = Math.min(total, anchorDist + VIEW_RADIUS_M);
  if (to - anchorDist < 0.5) return [];

  // Route window in geographic coords, starting exactly at the rider.
  const window = [positionAtDistance(geometry, cum, anchorDist)];
  for (let i = 0; i < geometry.length; i++) {
    if (cum[i] <= anchorDist) continue;
    if (cum[i] >= to) break;
    window.push(geometry[i]);
  }
  window.push(positionAtDistance(geometry, cum, to));

  // Densify, convert to rider-local metres, round the corners.
  const local = chaikin(densify(window).map((p) => toLocal(cam, p[1], p[0])), CHAIKIN_PASSES);

  // Ground arc length of the local polyline.
  const glen = [0];
  for (let i = 1; i < local.length; i++) {
    glen.push(glen[i - 1] + Math.hypot(local[i].forward - local[i - 1].forward, local[i].right - local[i - 1].right));
  }
  const gTotal = glen[glen.length - 1];
  if (gTotal < 0.5) return [];

  const n = Math.min(MAIN_PATH_POINTS, MAX_MAIN_PATH_POINTS);
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const g = (gTotal * k) / (n - 1);
    while (j < glen.length - 2 && glen[j + 1] < g) j++;
    const segLen = glen[j + 1] - glen[j] || 1;
    const t = Math.min(1, Math.max(0, (g - glen[j]) / segLen));
    const a = local[j], b = local[j + 1];
    let fwd = a.forward + (b.forward - a.forward) * t;
    const rgt = a.right + (b.right - a.right) * t;
    // The first point is the rider (forward = 0); a hair below 0 is float noise.
    if (k === 0) fwd = Math.max(fwd, NEAR_FORWARD_M);
    if (fwd < NEAR_FORWARD_M) break; // road goes behind the rider: stop here
    const s = projectLocal(fwd, rgt);
    out.push([toSubpx(s.x), toSubpx(s.y)]);
  }
  if (out.length < 2) return [];
  // Invariant: the stroke starts under the chevron.
  out[0] = [CENTER_X * SUBPX, PATH_BOT_Y * SUBPX];
  return out;
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
function buildSidePaths(roads, cam) {
  const candidates = [];
  for (let ri = 0; ri < roads.length; ri++) {
    // Keep only the single closest visible run of this road.
    let best = null;
    for (const r of projectPolyline(densify(roads[ri]), cam)) {
      if (!best || r.score < best.score) best = r;
    }
    if (best) candidates.push({ pts: best.pts, score: best.score, id: ri });
  }
  candidates.sort((a, b) => a.score - b.score); // nearest roads first
  const picked = candidates.slice(0, MAX_SIDE_PATHS);
  const n = Math.min(SIDE_PATH_POINTS, MAX_SIDE_PATH_POINTS);
  return {
    paths: picked.map((r) => resample(r.pts, n)),
    ids: picked.map((r) => r.id)
  };
}

/**
 * The next maneuver at along-route distance `dist`.
 *
 * Only maneuvers still ahead of the rider count. The small negative tolerance
 * holds the callout up while the bike is physically inside the junction, then
 * the next maneuver takes over. (Maneuvers already behind the rider used to be
 * selected, so the display showed a turn that had just been completed at 0 m.)
 */
function turnInfoAt(turnPoints, dist) {
  for (const tp of turnPoints) {
    if (tp.dist >= dist - 5) {
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

  // Spatially-smoothed tangent, temporally damped, clamped to the road ahead.
  const heading = cameraHeadingAt(geometry, cum, d, prevHeading);

  const cam = makeCamera(lat0, lng0, heading);
  const mainPath = buildMainPath(geometry, cum, d, cam);
  const side = buildSidePaths(roads, cam);
  const turn = turnInfoAt(turnPoints, d);

  const frame = {
    type: 'NAV_CHUNK',
    subpx: SUBPX,       // coordinates below are in 1/subpx pixel units
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
  // Final anchor sits a couple of metres short of the destination. Anchored
  // exactly at `total` there is nothing ahead of the rider to draw, so the frame
  // would carry an empty mainPath and the road would simply vanish on the last
  // frame of the preview.
  const lastAnchor = Math.max(0, total - 2);
  if (!anchors.length || anchors[anchors.length - 1] < lastAnchor) anchors.push(lastAnchor);

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
