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
 * Generate side road paths (wrong-turn indicators).
 * At a turn point, the "straight continuation" is the wrong way.
 */
function generateSidePaths(chunk, mainWaypoints) {
  const direction = chunk.direction || 'S';
  const sidePaths = [];

  // Only generate side roads for actual turns
  if (direction === 'S') return sidePaths;

  // Find the turn apex (roughly 40-60% up the path)
  const apexIndex = Math.floor(mainWaypoints.length * 0.4);
  const apex = mainWaypoints[Math.min(apexIndex, mainWaypoints.length - 1)];

  if (!apex) return sidePaths;

  // The side road continues straight from before the turn
  const beforeApex = mainWaypoints[Math.max(0, apexIndex - 2)];
  if (!beforeApex) return sidePaths;

  // Calculate the "straight ahead" direction from the segment before the turn
  const dx = apex[0] - beforeApex[0];
  const dy = apex[1] - beforeApex[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return sidePaths;

  const dirX = dx / len;
  const dirY = dy / len;

  // Generate a short straight continuation (the wrong way)
  const sideLength = 45; // pixels
  const sidePoints = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const x = Math.round(apex[0] + dirX * sideLength * t);
    const y = Math.round(apex[1] + dirY * sideLength * t);

    // Clamp to screen
    if (x >= 0 && x < SCREEN_W && y >= PATH_TOP_Y && y <= PATH_BOT_Y) {
      sidePoints.push([x, y]);
    }
  }

  if (sidePoints.length >= 2) {
    sidePaths.push(sidePoints);
  }

  // For U-turns, add a second side road on the opposite side
  if (direction === 'U' && mainWaypoints.length > 4) {
    const midIndex = Math.floor(mainWaypoints.length * 0.6);
    const midPoint = mainWaypoints[midIndex];
    if (midPoint) {
      const side2 = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const x = Math.round(midPoint[0] + 35 * t);
        const y = Math.round(midPoint[1] - 5 * t);
        if (x >= 0 && x < SCREEN_W && y >= PATH_TOP_Y) {
          side2.push([x, y]);
        }
      }
      if (side2.length >= 2) sidePaths.push(side2);
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

  // 2. Smooth the waypoints into a dense Bezier curve
  const mainPath = smoothPath(waypoints);

  // 3. Generate side roads (wrong-turn indicators)
  const sidePaths = generateSidePaths(chunk, waypoints);

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
