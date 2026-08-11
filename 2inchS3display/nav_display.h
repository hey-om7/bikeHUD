/*
 * nav_display.h - Minimalist pseudo-3D perspective navigation display
 * Tripper Telemetry Dashboard V5
 *
 * Centralized forward-perspective path with chevron position indicator,
 * inline distance/turn display, and curved progress arc.
 * Full black canvas — no top bars, no text clutter.
 */
#ifndef NAV_DISPLAY_H
#define NAV_DISPLAY_H

#include <Arduino_GFX_Library.h>
#include <math.h>
#include "config.h"
#include "server_connection.h"

extern Arduino_GFX *gfx;

// Navigation display colors
#define NAV_BG         0x0000   // Black background
#define NAV_PATH       0xFFFF   // White path
#define NAV_ARROW      0xFFFF   // White arrow/chevron
#define NAV_TEXT       0xFFFF   // White text
#define NAV_DIM        0x4208   // Dimmed gray for motion lines / background arcs
#define NAV_ACCENT     0xFDA0   // Orange accent
#define NAV_SHADOW     0x2104   // Dark shadow for 3D bevel

// Layout anchors
#define NAV_CX         160      // Horizontal center
#define NAV_PATH_BOT_Y 175      // Path origin (bottom of path area)
#define NAV_PATH_TOP_Y 20       // Path vanishing point area

static bool navDisplayActive = false;
static unsigned long lastNavRender = 0;

// drawThickLine is defined in dashboard.h — reused here

// ===== Draw Speed/Motion Lines =====
// Horizontal streaks trailing off the path sides for velocity feel
static void drawMotionLines(int pathX, int pathY, int spread) {
  // Draw 4 pairs of motion lines at various heights
  for (int i = 0; i < 4; i++) {
    int y = pathY - 20 - i * 30;
    if (y < NAV_PATH_TOP_Y) break;

    int lineLen = 15 + i * 5;
    int offset = spread - i * 4;
    if (offset < 8) offset = 8;

    // Left side motion lines
    gfx->drawFastHLine(NAV_CX - offset - lineLen, y, lineLen, NAV_DIM);
    gfx->drawFastHLine(NAV_CX - offset - lineLen + 3, y + 8, lineLen - 6, NAV_DIM);

    // Right side motion lines
    gfx->drawFastHLine(NAV_CX + offset, y, lineLen, NAV_DIM);
    gfx->drawFastHLine(NAV_CX + offset + 3, y + 8, lineLen - 6, NAV_DIM);
  }
}

// ===== Draw Breadcrumb Path (Pseudo-3D Perspective) =====
// Road originates from lower-center and zigzags upward toward vanishing point
void drawBreadcrumbPath(NavChunk* chunk) {
  // Build path points from chunk offsets, mapped to perspective
  // Each successive point is higher on screen (further away) and narrower (perspective)

  int numPoints = chunk->pathPointCount;
  if (numPoints < 1) numPoints = 1;
  if (numPoints > 10) numPoints = 10;

  // Generate perspective-mapped points
  // Y goes from NAV_PATH_BOT_Y up to NAV_PATH_TOP_Y
  // X converges toward center as Y goes up (perspective narrowing)

  int pathX[11];
  int pathY[11];

  // Origin point at bottom center
  pathX[0] = NAV_CX;
  pathY[0] = NAV_PATH_BOT_Y;

  float yStep = (float)(NAV_PATH_BOT_Y - NAV_PATH_TOP_Y) / (float)(numPoints + 1);

  for (int i = 0; i < numPoints; i++) {
    // Perspective factor: 1.0 at bottom, shrinks toward top
    float t = (float)(i + 1) / (float)(numPoints + 1);
    float perspective = 1.0f - t * 0.7f; // Narrows to 30% at the top

    // Use chunk path offsets for lateral displacement
    int offsetX = 0;
    if (i < chunk->pathPointCount) {
      offsetX = chunk->pathOffsets[i * 2]; // X offset from data
    }

    // Scale offset by perspective
    pathX[i + 1] = NAV_CX + (int)(offsetX * 2.5f * perspective);
    pathY[i + 1] = NAV_PATH_BOT_Y - (int)(yStep * (i + 1));
  }

  int totalPts = numPoints + 1;

  // Draw the thick white path segments
  int baseThickness = 8;
  for (int i = 0; i < totalPts - 1; i++) {
    // Thickness decreases with perspective
    float t = (float)i / (float)(totalPts - 1);
    int thick = baseThickness - (int)(t * 5);
    if (thick < 2) thick = 2;

    drawThickLine(pathX[i], pathY[i], pathX[i + 1], pathY[i + 1], thick, NAV_PATH);
  }

  // Draw motion/speed lines beside the path
  int spread = 35;
  drawMotionLines(pathX[0], pathY[0], spread);
}

// ===== Draw Position Chevron (3D Arrowhead) =====
// Prominent chevron at the bottom-center of the path
static void drawPositionChevron(int cx, int cy) {
  // Chevron dimensions
  int chevW = 18;  // Half-width
  int chevH = 22;  // Total height (tip to tail)
  int innerH = 10; // Inner cutout depth

  // Shadow (offset down-right by 2px)
  int sx = cx + 1;
  int sy = cy + 2;
  gfx->fillTriangle(sx, sy - chevH / 2,
                    sx - chevW, sy + chevH / 2,
                    sx + chevW, sy + chevH / 2, NAV_SHADOW);
  gfx->fillTriangle(sx, sy + chevH / 2 - innerH,
                    sx - chevW + 6, sy + chevH / 2,
                    sx + chevW - 6, sy + chevH / 2, NAV_SHADOW);

  // Main white chevron (pointing up)
  gfx->fillTriangle(cx, cy - chevH / 2,
                    cx - chevW, cy + chevH / 2,
                    cx + chevW, cy + chevH / 2, NAV_ARROW);

  // Inner dark cutout to create the "V" / bevel effect
  gfx->fillTriangle(cx, cy + chevH / 2 - innerH,
                    cx - chevW + 6, cy + chevH / 2,
                    cx + chevW - 6, cy + chevH / 2, NAV_BG);

  // Small inner highlight triangle for 3D depth
  gfx->fillTriangle(cx, cy - chevH / 2 + 4,
                    cx - chevW + 7, cy + chevH / 2 - innerH - 2,
                    cx + chevW - 7, cy + chevH / 2 - innerH - 2, NAV_DIM);
}

// ===== Draw Minimalist Turn Icon =====
// Small inline turn arrow rendered next to distance text
static void drawMiniTurnIcon(int cx, int cy, const char* direction) {
  int sz = 10; // Icon half-size

  if (strcmp(direction, "R") == 0) {
    // Right arrow: horizontal bar + right-pointing head
    gfx->fillRect(cx - sz, cy - 2, sz, 4, NAV_ARROW);
    gfx->fillTriangle(cx + sz, cy, cx + 2, cy - 7, cx + 2, cy + 7, NAV_ARROW);
    // Vertical stem (turn from straight)
    gfx->fillRect(cx - sz, cy - sz, 4, sz, NAV_ARROW);
  }
  else if (strcmp(direction, "L") == 0) {
    // Left arrow
    gfx->fillRect(cx, cy - 2, sz, 4, NAV_ARROW);
    gfx->fillTriangle(cx - sz, cy, cx - 2, cy - 7, cx - 2, cy + 7, NAV_ARROW);
    // Vertical stem
    gfx->fillRect(cx + sz - 4, cy - sz, 4, sz, NAV_ARROW);
  }
  else if (strcmp(direction, "U") == 0) {
    // U-turn: small arc with downward arrow
    gfx->drawArc(cx, cy - 4, 9, 6, 0.0f, 180.0f, NAV_ARROW);
    gfx->fillTriangle(cx + 9, cy + 4, cx + 5, cy - 2, cx + 13, cy - 2, NAV_ARROW);
  }
  else {
    // Straight: upward arrow
    gfx->fillRect(cx - 2, cy - sz, 4, sz * 2, NAV_ARROW);
    gfx->fillTriangle(cx, cy - sz - 5, cx - 6, cy - sz + 2, cx + 6, cy - sz + 2, NAV_ARROW);
  }
}

// ===== Draw Distance + Turn (Bottom Center) =====
static void drawDistanceAndTurn(NavChunk* chunk) {
  int distY = 200; // Y position for distance text
  int turnIconX = NAV_CX - 55; // Turn icon to the left of distance
  int turnIconY = distY + 8;

  // Draw mini turn icon
  drawMiniTurnIcon(turnIconX, turnIconY, chunk->direction);

  // Distance number (large bold)
  gfx->setTextSize(3);
  gfx->setTextColor(NAV_TEXT);

  char distBuf[8];
  char unitBuf[4];

  if (chunk->distanceMeters >= 1000) {
    float km = chunk->distanceMeters / 1000.0f;
    if (km >= 10.0f) {
      snprintf(distBuf, sizeof(distBuf), "%d", (int)km);
    } else {
      // One decimal for < 10 km
      int whole = (int)km;
      int frac = (int)((km - whole) * 10);
      snprintf(distBuf, sizeof(distBuf), "%d.%d", whole, frac);
    }
    strcpy(unitBuf, "km");
  } else {
    snprintf(distBuf, sizeof(distBuf), "%d", chunk->distanceMeters);
    strcpy(unitBuf, "m");
  }

  // Calculate text width for centering (approx 18px per char at size 3)
  int distLen = strlen(distBuf);
  int textW = distLen * 18;
  int distX = NAV_CX - textW / 2 + 10; // Slightly right to account for turn icon

  gfx->setCursor(distX, distY);
  gfx->print(distBuf);

  // Unit text (smaller, positioned right after the number)
  gfx->setTextSize(2);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(distX + textW + 4, distY + 6);
  gfx->print(unitBuf);
}

// ===== Draw Curved Progress Arc =====
// Thin arc at the bottom showing distance progress to next turn
static void drawProgressArc(NavChunk* chunk) {
  int arcCX = NAV_CX;
  int arcCY = 260; // Center below screen — only the top of arc is visible
  int arcR_outer = 38;
  int arcR_inner = 34;

  // Calculate progress (chunk index / total chunks)
  float progress = 0.0f;
  if (chunk->totalChunks > 0) {
    progress = (float)(chunk->chunkIndex) / (float)(chunk->totalChunks);
  }
  if (progress > 1.0f) progress = 1.0f;

  // Arc spans from 200 to 340 degrees (a wide bottom arc visible on screen)
  float arcStart = 210.0f;
  float arcEnd = 330.0f;
  float arcSpan = arcEnd - arcStart;

  // Background arc (full span, dim)
  gfx->drawArc(arcCX, arcCY, arcR_outer, arcR_inner, arcStart, arcEnd, NAV_DIM);

  // Foreground arc (progress-filled, white)
  if (progress > 0.01f) {
    float fillEnd = arcStart + arcSpan * progress;
    gfx->drawArc(arcCX, arcCY, arcR_outer, arcR_inner, arcStart, fillEnd, NAV_ARROW);
  }
}

// ===== Draw Navigation Screen (Main Render) =====
void drawNavScreen(NavChunk* chunk) {
  // Clean full black canvas
  gfx->fillScreen(NAV_BG);

  // 1. Perspective breadcrumb path (the core visual)
  drawBreadcrumbPath(chunk);

  // 2. Position chevron at bottom-center of path
  drawPositionChevron(NAV_CX, NAV_PATH_BOT_Y + 5);

  // 3. Distance + turn direction (bottom center)
  drawDistanceAndTurn(chunk);

  // 4. Progress arc (very bottom)
  drawProgressArc(chunk);
}

// ===== Draw Navigation Complete Screen =====
void drawNavComplete() {
  gfx->fillScreen(NAV_BG);

  // Checkmark
  int cx = NAV_CX;
  int cy = 90;
  gfx->drawLine(cx - 18, cy, cx - 5, cy + 14, COL_GREEN);
  gfx->drawLine(cx - 17, cy, cx - 4, cy + 14, COL_GREEN);
  gfx->drawLine(cx - 5, cy + 14, cx + 20, cy - 10, COL_GREEN);
  gfx->drawLine(cx - 4, cy + 14, cx + 21, cy - 10, COL_GREEN);

  gfx->setTextSize(2);
  gfx->setTextColor(COL_GREEN);
  gfx->setCursor(cx - 66, 120);
  gfx->print("DESTINATION");
  gfx->setCursor(cx - 48, 145);
  gfx->print("REACHED");

  gfx->setTextSize(1);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(cx - 60, 185);
  gfx->print("Returning to dashboard...");
}

// ===== Enter Navigation Mode =====
void enterNavMode() {
  navDisplayActive = true;
  gfx->fillScreen(NAV_BG);

  // Minimal waiting state
  gfx->setTextSize(2);
  gfx->setTextColor(NAV_TEXT);
  gfx->setCursor(NAV_CX - 72, 105);
  gfx->print("Starting...");

  gfx->setTextSize(1);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(NAV_CX - 66, 140);
  gfx->print("Waiting for route");
}

// ===== Exit Navigation Mode =====
void exitNavMode() {
  navDisplayActive = false;
  clearNavigation();
}

// ===== Check if Navigation Display is Active =====
bool isNavDisplayActive() {
  return navDisplayActive;
}

// ===== Navigation Display Loop =====
// Called from main loop when navigation is active
// Returns true if navigation is still active, false if it should return to dashboard
bool navDisplayLoop() {
  if (!navDisplayActive) return false;

  unsigned long now = millis();
  NavState state = getNavState();

  if (state == NAV_ACTIVE) {
    if (hasNavigationChunk()) {
      NavChunk* chunk = getCurrentNavChunk();
      drawNavScreen(chunk);
      lastNavRender = now;
    }
  }
  else if (state == NAV_COMPLETE) {
    if (now - lastNavRender > 500) {
      drawNavComplete();
      lastNavRender = now;

      // Auto-return to dashboard after 3 seconds
      static unsigned long completeTime = 0;
      if (completeTime == 0) completeTime = now;
      if (now - completeTime > 3000) {
        completeTime = 0;
        exitNavMode();
        return false;
      }
    }
  }
  else if (state == NAV_IDLE && navDisplayActive) {
    // Navigation was stopped externally
    exitNavMode();
    return false;
  }

  return true;
}

#endif // NAV_DISPLAY_H
