/*
 * nav_display.h - Minimalist pseudo-3D navigation display (server-rendered paths)
 * Tripper Telemetry Dashboard V5
 *
 * Consumes pre-calculated screen coordinates from the Node.js server.
 * Renders smooth Bezier paths, side roads, 3D chevron, distance/turn, progress arc.
 * Full black canvas — no clutter.
 */
#ifndef NAV_DISPLAY_H
#define NAV_DISPLAY_H

#include <Arduino_GFX_Library.h>
#include <math.h>
#include "config.h"
#include "server_connection.h"
#include "nav_arrow.h"

extern Arduino_GFX *gfx;
extern int gpsSatellites;

// Navigation display colors
#define NAV_BG         0x0000   // Black background
#define NAV_PATH       0xFFFF   // White main path
#define NAV_DIM        0x4208   // Gray for motion lines / arc background
#define NAV_SIDE       0x8410   // Mid-gray side-road base (fades toward NAV_BG)
#define NAV_ARROW      0xFFFF   // White chevron
#define NAV_TEXT       0xFFFF   // White text
// (3D shading now baked into nav_arrow.h bitmap)
#define NAV_ACCENT     0xFDA0   // Orange accent

// Layout
#define NAV_CX         160      // Horizontal center
#define NAV_PATH_BOT_Y 175      // Path origin Y
#define NAV_PATH_TOP_Y 25       // Vanishing point Y (matches server pathRenderer)

// Main path stroke thickness (perspective taper: wide near rider, thin far away)
#define PATH_MAX_THICK 18        // Stroke width at the near/bottom end
#define PATH_MIN_THICK 2        // Stroke width at the far/vanishing end

// ===== Rendering Helpers =====

// Linear blend between two RGB565 colors. f=0 -> c0, f=1 -> c1.
// Used to fade side roads from NAV_SIDE into the background.
static uint16_t navBlend565(uint16_t c0, uint16_t c1, float f) {
  if (f <= 0.0f) return c0;
  if (f >= 1.0f) return c1;
  int r0 = (c0 >> 11) & 0x1F, g0 = (c0 >> 5) & 0x3F, b0 = c0 & 0x1F;
  int r1 = (c1 >> 11) & 0x1F, g1 = (c1 >> 5) & 0x3F, b1 = c1 & 0x1F;
  int r = r0 + (int)((r1 - r0) * f + 0.5f);
  int g = g0 + (int)((g1 - g0) * f + 0.5f);
  int b = b0 + (int)((b1 - b0) * f + 0.5f);
  return (uint16_t)((r << 11) | (g << 5) | b);
}

// Solid thick line: rasterizes parallel drawLine passes along the segment
// normal. Round joins/caps are added separately by the caller via fillCircle.
static void navThickLine(int x0, int y0, int x1, int y1, int thickness, uint16_t color) {
  if (thickness < 1) thickness = 1;
  float dx = x1 - x0;
  float dy = y1 - y0;
  float len = sqrtf(dx * dx + dy * dy);
  if (len < 0.5f) {
    gfx->fillCircle(x0, y0, thickness / 2, color);
    return;
  }
  float nx = -dy / len;
  float ny = dx / len;
  int half = thickness / 2;
  for (int i = -half; i <= half; i++) {
    gfx->drawLine(x0 + (int)(nx * i), y0 + (int)(ny * i),
                  x1 + (int)(nx * i), y1 + (int)(ny * i), color);
  }
}

// Perspective stroke width for a given screen Y (thicker near the rider).
static int navPathThickness(int y) {
  float t = (float)(NAV_PATH_BOT_Y - y) / (float)(NAV_PATH_BOT_Y - NAV_PATH_TOP_Y);
  if (t < 0.0f) t = 0.0f;
  if (t > 1.0f) t = 1.0f;
  int th = (int)(PATH_MAX_THICK - t * (PATH_MAX_THICK - PATH_MIN_THICK) + 0.5f);
  if (th < PATH_MIN_THICK) th = PATH_MIN_THICK;
  return th;
}

static bool navDisplayActive = false;
static unsigned long lastNavRender = 0;
static unsigned long lastFrameAdvance = 0;

// How often to roll forward to the next pre-rendered frame while navigating.
// Frames are sampled ~every 25m along the route on the server, so this sets the
// playback speed of the rolling map (dev/sim behavior; a GPS-driven device would
// advance based on distance travelled instead).
#define NAV_FRAME_ADVANCE_MS  700

// ===== Draw Main Path (Continuous Solid Stroke) =====
// Renders the server-provided polyline as ONE connected vector stroke:
//  - consecutive points joined with a solid thick line (no gaps, no dots)
//  - a filled circle at every vertex/endpoint gives round joins and round caps
//  - stroke width tapers with perspective (wide near rider, thin toward horizon)
static void drawMainPath(NavChunk* chunk) {
  if (chunk->mainPathCount < 2) return;

  for (uint8_t i = 0; i < chunk->mainPathCount - 1; i++) {
    int16_t x0 = chunk->mainPath[i].x;
    int16_t y0 = chunk->mainPath[i].y;
    int16_t x1 = chunk->mainPath[i + 1].x;
    int16_t y1 = chunk->mainPath[i + 1].y;

    int th = navPathThickness((y0 + y1) / 2);

    // Solid segment + round join at its start vertex (also caps the origin).
    navThickLine(x0, y0, x1, y1, th, NAV_PATH);
    gfx->fillCircle(x0, y0, th / 2, NAV_PATH);
  }

  // Round cap at the final (far) point.
  uint8_t last = chunk->mainPathCount - 1;
  int thEnd = navPathThickness(chunk->mainPath[last].y);
  gfx->fillCircle(chunk->mainPath[last].x, chunk->mainPath[last].y, thEnd / 2, NAV_PATH);
}

// ===== Draw Surrounding Roads (Thin, Solid, Gray) =====
// These are the real nearby roads the server projected into the current view
// (sim.html's gray side-streets). They are drawn as continuous thin GRAY
// polylines so the rider can see the road network around the active route,
// while the white main path stays the clear focus. No branch/fade assumptions:
// each side path is just a visible map road segment in the local frame.
static void drawSideRoads(NavChunk* chunk) {
  for (uint8_t s = 0; s < chunk->sidePathCount; s++) {
    SidePath* sp = &chunk->sidePaths[s];
    if (sp->count < 2) continue;

    for (uint8_t i = 0; i < sp->count - 1; i++) {
      int16_t x0 = sp->points[i].x;
      int16_t y0 = sp->points[i].y;
      int16_t x1 = sp->points[i + 1].x;
      int16_t y1 = sp->points[i + 1].y;

      // Steady gray for all surrounding roads. Slightly dimmer/thinner toward
      // the top of the frame (farther away) for a gentle depth cue, but never
      // fading into the background — nearby roads must stay visible.
      int midY = (y0 + y1) / 2;
      float t = (float)(NAV_PATH_BOT_Y - midY) / (float)(NAV_PATH_BOT_Y - NAV_PATH_TOP_Y);
      if (t < 0.0f) t = 0.0f;
      if (t > 1.0f) t = 1.0f;
      uint16_t col = navBlend565(0xAD55, 0x630C, t);  // near light-gray -> far mid-gray
      int th = (t < 0.5f) ? 2 : 1;

      navThickLine(x0, y0, x1, y1, th, col);
      if (th >= 2) gfx->fillCircle(x0, y0, 1, col);  // subtle round join
    }
  }
}
// ===== Draw 3D Chevron (Bitmap Arrowhead) =====
// Renders the pre-rendered 3D arrowhead bitmap centered at (cx, cy)
// Skips black (0x0000) pixels for transparency against black background
static void drawChevron3D(int cx, int cy) {
  int startX = cx - NAV_ARROW_W / 2;
  int startY = cy - NAV_ARROW_H / 2;

  for (int y = 0; y < NAV_ARROW_H; y++) {
    int screenY = startY + y;
    if (screenY < 0 || screenY >= SCREEN_H) continue;

    for (int x = 0; x < NAV_ARROW_W; x++) {
      int screenX = startX + x;
      if (screenX < 0 || screenX >= SCREEN_W) continue;

      uint16_t color = pgm_read_word(&nav_arrow_bitmap[y * NAV_ARROW_W + x]);
      if (color != 0x0000) {
        gfx->drawPixel(screenX, screenY, color);
      }
    }
  }
}

// ===== Draw Minimalist Turn Icon =====
static void drawMiniTurnIcon(int cx, int cy, const char* direction) {
  int sz = 10;

  if (strcmp(direction, "R") == 0) {
    // Right turn: vertical stem + right arrow
    gfx->fillRect(cx - 1, cy - sz, 3, sz, NAV_ARROW);
    gfx->fillRect(cx - 1, cy - 1, sz, 3, NAV_ARROW);
    gfx->fillTriangle(cx + sz + 1, cy, cx + sz - 4, cy - 5, cx + sz - 4, cy + 5, NAV_ARROW);
  }
  else if (strcmp(direction, "L") == 0) {
    // Left turn: vertical stem + left arrow
    gfx->fillRect(cx - 1, cy - sz, 3, sz, NAV_ARROW);
    gfx->fillRect(cx - sz, cy - 1, sz, 3, NAV_ARROW);
    gfx->fillTriangle(cx - sz - 1, cy, cx - sz + 4, cy - 5, cx - sz + 4, cy + 5, NAV_ARROW);
  }
  else if (strcmp(direction, "U") == 0) {
    // U-turn: arc + down arrow
    gfx->drawArc(cx, cy - 5, 8, 5, 0.0f, 180.0f, NAV_ARROW);
    gfx->fillRect(cx + 7, cy - 5, 3, 10, NAV_ARROW);
    gfx->fillTriangle(cx + 8, cy + 7, cx + 4, cy + 2, cx + 12, cy + 2, NAV_ARROW);
  }
  else {
    // Straight: up arrow
    gfx->fillRect(cx - 1, cy - sz, 3, sz * 2, NAV_ARROW);
    gfx->fillTriangle(cx, cy - sz - 6, cx - 5, cy - sz, cx + 5, cy - sz, NAV_ARROW);
  }
}

// ===== Draw Distance + Turn Direction (Right Side) =====
static void drawDistanceAndTurn(NavChunk* chunk) {
  // Vertical center for the distance readout on the right side.
  int distY = SCREEN_H / 2 - 10;

  // Build the distance string + unit.
  char distBuf[8];
  char unitBuf[4];
  if (chunk->distanceMeters >= 1000) {
    float km = chunk->distanceMeters / 1000.0f;
    if (km >= 10.0f) {
      snprintf(distBuf, sizeof(distBuf), "%d", (int)km);
    } else {
      int whole = (int)km;
      int frac = (int)((km - whole) * 10);
      snprintf(distBuf, sizeof(distBuf), "%d.%d", whole, frac);
    }
    strcpy(unitBuf, "km");
  } else {
    snprintf(distBuf, sizeof(distBuf), "%d", chunk->distanceMeters);
    strcpy(unitBuf, "m");
  }

  // Measure the number block (text size 3 => ~18px per glyph).
  int distLen = strlen(distBuf);
  int numW = distLen * 18;
  int unitW = strlen(unitBuf) * 12;   // size 2 => ~12px per glyph
  int gap = 4;
  int rightPad = 18;

  // Whole block (number + gap + unit) is right-aligned against the screen edge.
  int blockW = numW + gap + unitW;
  int numX = SCREEN_W - rightPad - blockW;
  int unitX = numX + numW + gap;
  int blockCX = numX + blockW / 2;

  // Turn icon centered above the block, clear of the GPS dots up top.
  // drawMiniTurnIcon(blockCX, distY - 24, chunk->direction);
  drawMiniTurnIcon(numX - 20, distY + 8, chunk->direction);

  // Distance number (large, white).
  gfx->setTextSize(3);
  gfx->setTextColor(NAV_TEXT);
  gfx->setCursor(numX, distY);
  gfx->print(distBuf);

  // Unit (smaller, dim, baseline-aligned to the number).
  gfx->setTextSize(2);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(unitX, distY + 8);
  gfx->print(unitBuf);
}

// ===== Draw Curved Progress Arc =====
static void drawProgressArc(NavChunk* chunk) {
  int arcCX = NAV_CX;
  int arcCY = 258;  // Center below visible screen — top of arc peeks in
  int arcR_outer = 36;
  int arcR_inner = 32;

  // Progress = current chunk / total
  float progress = 0.0f;
  if (chunk->totalChunks > 0) {
    progress = (float)(chunk->chunkIndex) / (float)(chunk->totalChunks);
  }
  if (progress > 1.0f) progress = 1.0f;

  float arcStart = 210.0f;
  float arcEnd = 330.0f;
  float arcSpan = arcEnd - arcStart;

  // Background arc (dim gray)
  gfx->drawArc(arcCX, arcCY, arcR_outer, arcR_inner, arcStart, arcEnd, NAV_DIM);

  // Filled foreground arc (white, proportional to progress)
  if (progress > 0.01f) {
    float fillEnd = arcStart + arcSpan * progress;
    gfx->drawArc(arcCX, arcCY, arcR_outer, arcR_inner, arcStart, fillEnd, NAV_ARROW);
  }
}

// ===== Draw GPS Signal Dots (Top-Right Corner, White) =====
static void drawNavGPSDots() {
  int dotR = 3;
  int dotSpacing = 12;
  int startX = SCREEN_W - 4 * dotSpacing - 8;
  int dotY = 12;

  int strength = min(gpsSatellites / 2, 4);  // 0-4 dots filled based on satellites

  for (int i = 0; i < 4; i++) {
    int cx = startX + i * dotSpacing;
    if (i < strength) {
      gfx->fillCircle(cx, dotY, dotR, NAV_TEXT);  // White filled
    } else {
      gfx->drawCircle(cx, dotY, dotR, NAV_DIM);   // Gray outline
    }
  }
}

// ===== Draw Navigation Screen (Main Render) =====
void drawNavScreen(NavChunk* chunk) {
  // 1. Clean full black canvas
  gfx->fillScreen(NAV_BG);

  // 2. Draw side roads first (behind main path)
  drawSideRoads(chunk);

  // 3. Draw main smooth path (thick white)
  drawMainPath(chunk);

  // 4. Draw 3D chevron at path origin
  drawChevron3D(NAV_CX, NAV_PATH_BOT_Y + 8);

  // 5. Distance + turn icon (right side)
  drawDistanceAndTurn(chunk);

  // 6. GPS signal dots (top-right corner)
  drawNavGPSDots();

  // 7. Progress arc (very bottom)
  drawProgressArc(chunk);
}

// ===== Draw Navigation Complete Screen =====
void drawNavComplete() {
  gfx->fillScreen(NAV_BG);

  int cx = NAV_CX;

  // Checkmark icon
  gfx->drawLine(cx - 18, 90, cx - 5, 104, COL_GREEN);
  gfx->drawLine(cx - 17, 90, cx - 4, 104, COL_GREEN);
  gfx->drawLine(cx - 16, 90, cx - 3, 104, COL_GREEN);
  gfx->drawLine(cx - 5, 104, cx + 20, 80, COL_GREEN);
  gfx->drawLine(cx - 4, 104, cx + 21, 80, COL_GREEN);
  gfx->drawLine(cx - 3, 104, cx + 22, 80, COL_GREEN);

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
  lastFrameAdvance = millis();
  gfx->fillScreen(NAV_BG);

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
// Called from main loop when navigation is active.
// Returns true if still in nav mode, false to return to dashboard.
bool navDisplayLoop() {
  if (!navDisplayActive) return false;

  unsigned long now = millis();
  NavState state = getNavState();

  if (state == NAV_ACTIVE) {
    if (hasNavigationChunk()) {
      // A fresh frame arrived from the server — render it and reset the roll timer.
      NavChunk* chunk = getCurrentNavChunk();
      drawNavScreen(chunk);
      lastNavRender = now;
      lastFrameAdvance = now;
    }
    else if (now - lastFrameAdvance >= NAV_FRAME_ADVANCE_MS) {
      // Roll forward: request the next frame (or finish if this was the last).
      advanceNavigation();
      lastFrameAdvance = now;
    }
  }
  else if (state == NAV_COMPLETE) {
    if (now - lastNavRender > 500) {
      drawNavComplete();
      lastNavRender = now;

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
    exitNavMode();
    return false;
  }

  return true;
}

#endif // NAV_DISPLAY_H
