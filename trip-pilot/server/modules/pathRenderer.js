/**
 * pathRenderer.js - Server-side path calculation for ESP32 navigation display
 *
 * Takes a navigation chunk (direction, distance, bearing, raw path offsets)
 * and generates smooth, pre-calculated screen coordinates for a 320x240 display.
 *
 * Output:
 *  - mainPath: Array of [x, y] screen coords (Bezier-smoothed, densely packed)
 *  - sidePaths: Array of coordinate arrays for adjacent/wrong-turn roads
 *  - direction, distance, chunkIndex, totalChunks, isLast
 */

// Screen constants (must match ESP32 config.h)
const SCREEN_W = 320;
const SCREEN_H = 240;
const CENTER_X = 160;

// Path rendering area
const PATH_TOP_Y = 25;       // Vanishing point area
const PATH_BOT_Y = 175;      // Path origin (bottom of path zone)
const PATH_DENSITY = 5;      // One point every ~5 pixels along the curve

// Firmware buffer limits (must match server_connection.h on the ESP32).
// The main path is a single continuous polyline; if the smoothed curve produces
// more vertices than the device can store it is uniformly decimated (endpoints
// preserved) so the stroke stays continuous instead of being truncated mid-road.
const MAX_MAIN_PATH_POINTS = 64;
const MAX_SIDE_PATHS = 3;
const MAX_SIDE_PATH_POINTS = 12;

/**
 * Evaluate a cubic Bezier at parameter t (0..1)
 */
function cubicBezier(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return (
    mt2 * mt * p0 +
    3 * mt2 * t * p1 +
    3 * mt * t2 * p2 +
    t2 * t * p3
  );
}

/**
 * Generate a smooth Bezier curve through a set of waypoints.
 * Uses Catmull-Rom to Bezier conversion for C1 continuity.
 * Returns densely packed [x, y] pairs.
 */
function smoothPath(waypoints) {
  if (waypoints.length < 2) return waypoints;
  if (waypoints.length === 2) {
    // Simple linear interpolation for two points
    return interpolateLinear(waypoints[0], waypoints[1]);
  }

  const result = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const p0 = waypoints[Math.max(0, i - 1)];
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    const p3 = waypoints[Math.min(waypoints.length - 1, i + 2)];

    // Catmull-Rom to cubic Bezier control points
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;

    // Calculate segment length for density
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(3, Math.round(segLen / PATH_DENSITY));

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(cubicBezier(p1[0], cp1x, cp2x, p2[0], t));
      const y = Math.round(cubicBezier(p1[1], cp1y, cp2y, p2[1], t));

      // Avoid duplicates
      if (result.length === 0 || result[result.length - 1][0] !== x || result[result.length - 1][1] !== y) {
        result.push([x, y]);
      }
    }
  }

  return result;
}

/**
 * Linear interpolation between two points, yielding dense coords
 */
function interpolateLinear(a, b) {
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(2, Math.round(dist / PATH_DENSITY));
  const result = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    result.push([
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t)
    ]);
  }
  return result;
}

/**
 * Uniformly decimate a dense polyline down to at most `maxCount` points while
 * always keeping the first and last vertex. This keeps the line continuous
 * (the ESP renders it as a connected stroke) even if the Bezier smoothing
 * produced more points than the device buffer can hold.
 */
function capPoints(points, maxCount) {
  if (points.length <= maxCount) return points;
  const result = [];
  const stride = (points.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) {
    result.push(points[Math.round(i * stride)]);
  }
  return result;
}

/**
 * Apply perspective narrowing: points higher on screen are closer to center X.
 * This creates the forward-driving illusion.
 */
function applyPerspective(x, y) {
  const t = (PATH_BOT_Y - y) / (PATH_BOT_Y - PATH_TOP_Y); // 0 at bottom, 1 at top
  const perspectiveFactor = 1.0 - t * 0.65; // Narrows to 35% at top
  const offsetFromCenter = x - CENTER_X;
  return [
    Math.round(CENTER_X + offsetFromCenter * perspectiveFactor),
    y
  ];
}

/**
 * Generate raw waypoints from chunk data (direction + path offsets).
 * Maps the navigation instruction into screen-space control points.
 */
function generateWaypoints(chunk) {
  const direction = chunk.direction || 'S';
  const pathOffsets = chunk.path || [];
  const waypoints = [];

  // Origin: bottom center
  waypoints.push([CENTER_X, PATH_BOT_Y]);

  const totalHeight = PATH_BOT_Y - PATH_TOP_Y;
  const numPoints = Math.min(Math.floor(pathOffsets.length / 2), 10);

  if (numPoints > 0) {
    // Use path offset data from the navigation engine
    for (let i = 0; i < numPoints; i++) {
      const t = (i + 1) / (numPoints + 1);
      const rawX = pathOffsets[i * 2] || 0;
      const rawY = pathOffsets[i * 2 + 1] || 0;

      // Scale offsets to screen space
      const x = CENTER_X + rawX * 3;
      const y = PATH_BOT_Y - totalHeight * t;
      waypoints.push([x, y]);
    }
  } else {
    // Fallback: generate waypoints based on direction
    const turnMagnitude = 50; // pixels of lateral displacement for turns

    switch (direction) {
      case 'R':
        waypoints.push([CENTER_X, PATH_BOT_Y - totalHeight * 0.3]);
        waypoints.push([CENTER_X + turnMagnitude * 0.5, PATH_BOT_Y - totalHeight * 0.5]);
        waypoints.push([CENTER_X + turnMagnitude, PATH_BOT_Y - totalHeight * 0.7]);
        waypoints.push([CENTER_X + turnMagnitude, PATH_BOT_Y - totalHeight * 0.9]);
        break;
      case 'L':
        waypoints.push([CENTER_X, PATH_BOT_Y - totalHeight * 0.3]);
        waypoints.push([CENTER_X - turnMagnitude * 0.5, PATH_BOT_Y - totalHeight * 0.5]);
        waypoints.push([CENTER_X - turnMagnitude, PATH_BOT_Y - totalHeight * 0.7]);
        waypoints.push([CENTER_X - turnMagnitude, PATH_BOT_Y - totalHeight * 0.9]);
        break;
      case 'U':
        waypoints.push([CENTER_X, PATH_BOT_Y - totalHeight * 0.2]);
        waypoints.push([CENTER_X + turnMagnitude, PATH_BOT_Y - totalHeight * 0.4]);
        waypoints.push([CENTER_X + turnMagnitude, PATH_BOT_Y - totalHeight * 0.6]);
        waypoints.push([CENTER_X - turnMagnitude * 0.5, PATH_BOT_Y - totalHeight * 0.7]);
        waypoints.push([CENTER_X - turnMagnitude, PATH_BOT_Y - totalHeight * 0.85]);
        break;
      default: // Straight
        waypoints.push([CENTER_X, PATH_BOT_Y - totalHeight * 0.25]);
        waypoints.push([CENTER_X, PATH_BOT_Y - totalHeight * 0.5]);
        waypoints.push([CENTER_X, PATH_BOT_Y - totalHeight * 0.75]);
        waypoints.push([CENTER_X, PATH_BOT_Y - totalHeight * 1.0]);
        break;
    }
  }

  // Apply perspective to all waypoints
  return waypoints.map(([x, y]) => applyPerspective(x, y));
}

/**
 * Generate side road paths that branch off the main navigation line.
 *
 * These are the faint roads that fork away from the route and trail off toward
 * the horizon in the reference design. Each side road is emitted as a continuous
 * polyline ordered from ROOT (touching the main path, drawn brightest) to TIP
 * (deep in the scene, faded into the background by the firmware). Perspective
 * narrowing is applied so branches pull toward the vanishing point and recede.
 *
 * @param {Object} chunk    - Navigation chunk (used to bias branch placement on turns)
 * @param {Array}  mainPath - Dense main-path polyline in screen coordinates
 * @returns {Array<Array<[number, number]>>} up to MAX_SIDE_PATHS branch polylines
 */
function generateSidePaths(chunk) {
  const sidePaths = [];
  
  // If the routing engine didn't provide real side roads, return empty.
  // No more guessing!
  if (!chunk.sidePathsRaw || !Array.isArray(chunk.sidePathsRaw)) {
    return sidePaths;
  }

  // Process the real side roads provided by your map API
  const totalHeight = PATH_BOT_Y - PATH_TOP_Y;

  for (let b = 0; b < chunk.sidePathsRaw.length && sidePaths.length < MAX_SIDE_PATHS; b++) {
    const rawBranch = chunk.sidePathsRaw[b]; // Expected format: [x1, y1, x2, y2...]
    const numPoints = Math.floor(rawBranch.length / 2);
    const pts = [];

    for (let i = 0; i < numPoints; i++) {
      const t = (i + 1) / (numPoints + 1);
      const rawX = rawBranch[i * 2] || 0;
      const rawY = rawBranch[i * 2 + 1] || 0;

      // Scale offsets to screen space (using the same logic as your main path)
      const scaledX = CENTER_X + rawX * 3;
      const scaledY = PATH_BOT_Y - totalHeight * t;

      // Apply perspective to recede toward the vanishing point
      const [x, y] = applyPerspective(scaledX, scaledY);

      // Bounds checking
      if (x < 0 || x >= SCREEN_W || y < PATH_TOP_Y - 5 || y > PATH_BOT_Y) continue;

      // Dedupe consecutive identical rounded points
      if (pts.length === 0 || pts[pts.length - 1][0] !== x || pts[pts.length - 1][1] !== y) {
        pts.push([x, y]);
      }
    }

    // Smooth the real side road, cap it for the ESP buffer, and add it
    if (pts.length >= 2) {
      const smoothedSidePath = smoothPath(pts);
      sidePaths.push(capPoints(smoothedSidePath, MAX_SIDE_PATH_POINTS));
    }
  }

  return sidePaths;
}

/**
 * Main entry point: render a navigation chunk into screen coordinates.
 *
 * @param {Object} chunk - Navigation chunk from NavigationEngine
 *   { instruction, direction, distance, bearing, path: [x,y,x,y,...] }
 * @param {number} chunkIndex - Current chunk index
 * @param {number} totalChunks - Total number of chunks
 * @returns {Object} Rendered payload for ESP32
 */
export function renderChunkToScreen(chunk, chunkIndex, totalChunks) {
  // 1. Generate raw waypoints from chunk data
  const waypoints = generateWaypoints(chunk);

  // 2. Smooth the waypoints into a dense, continuous Bezier polyline
  const mainPath = capPoints(smoothPath(waypoints), MAX_MAIN_PATH_POINTS);

  // 3. Process REAL side roads from the chunk (no longer requires mainPath as an argument)
  const sidePaths = generateSidePaths(chunk);

  // 4. Build compact payload
  return {
    type: 'NAV_CHUNK',
    mainPath,
    sidePaths,
    direction: chunk.direction || 'S',
    distance: chunk.distance || 0,
    instruction: chunk.instruction || 'Continue',
    bearing: chunk.bearing || 0,
    chunkIndex,
    totalChunks,
    isLast: chunkIndex === totalChunks - 1
  };
}
