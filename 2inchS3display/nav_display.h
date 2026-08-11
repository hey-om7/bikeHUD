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

extern Arduino_GFX *gfx;

// Navigation display colors
#define NAV_BG         0x0000   // Black background
#define NAV_PATH       0xFFFF   // White main path
#define NAV_DIM        0x4208   // Gray for side roads and motion lines
#define NAV_ARROW      0xFFFF   // White chevron
#define NAV_TEXT       0xFFFF   // White text
#define NAV_SHADOW     0x2104   // Dark shadow for 3D bevel
#define NAV_FACET_L    0xC618   // Light gray left facet
#define NAV_FACET_R    0x8410   // Darker gray right facet
#define NAV_ACCENT     0xFDA0   // Orange accent

// Layout
#define NAV_CX         160      // Horizontal center
#define NAV_PATH_BOT_Y 175      // Path origin Y

// Path rendering params
#define PATH_CIRCLE_R  4        // Radius for thick main path dots
#define SIDE_CIRCLE_R  1        // Radius for thin side road dots

static bool navDisplayActive = false;
static unsigned long lastNavRender = 0;

// ===== Draw Main Path (Thick, Smooth) =====
// Renders by stamping filled circles at each server-provided coordinate
static void drawMainPath(NavChunk* chunk) {
  if (chunk->mainPathCount < 2) return;

  for (uint8_t i = 0; i < chunk->mainPathCount; i++) {
    int16_t x = chunk->mainPath[i].x;
    int16_t y = chunk->mainPath[i].y;

    // Clamp to screen
    if (x < 0 || x >= SCREEN_W || y < 0 || y >= SCREEN_H) continue;

    // Stamp filled circle for thick path appearance
    gfx->fillCircle(x, y, PATH_CIRCLE_R, NAV_PATH);
  }
}

// ===== Draw Side Roads (Thin, Dimmed) =====
// Wrong-turn indicators rendered thinner in gray
static void drawSideRoads(NavChunk* chunk) {
  for (uint8_t s = 0; s < chunk->sidePathCount; s++) {
    SidePath* sp = &chunk->sidePaths[s];
    if (sp->count < 2) continue;

    for (uint8_t i = 0; i < sp->count; i++) {
      int16_t x = sp->points[i].x;
      int16_t y = sp->points[i].y;

      if (x < 0 || x >= SCREEN_W || y < 0 || y >= SCREEN_H) continue;

      gfx->fillCircle(x, y, SIDE_CIRCLE_R, NAV_DIM);
    }

    // Connect with thin lines for continuity
    for (uint8_t i = 0; i < sp->count - 1; i++) {
      int16_t x0 = sp->points[i].x;
      int16_t y0 = sp->points[i].y;
      int16_t x1 = sp->points[i + 1].x;
      int16_t y1 = sp->points[i + 1].y;
      gfx->drawLine(x0, y0, x1, y1, NAV_DIM);
    }
  }
}

// ===== Draw 3D Chevron (Beveled Arrowhead) =====
// Three overlapping triangles create a 3D beveled look
static void drawChevron3D(int cx, int cy) {
  // Chevron geometry
  int tipY = cy - 16;    // Top point
  int baseY = cy + 10;   // Bottom edge
  int halfW = 14;        // Half-width at base
  int midY = cy;         // Middle split point

  // Drop shadow (offset +2, +2)
  gfx->fillTriangle(
    cx + 2, tipY + 2,
    cx - halfW + 2, baseY + 2,
    cx + halfW + 2, baseY + 2,
    NAV_SHADOW
  );

  // Right facet (darker gray)
  gfx->fillTriangle(
    cx, tipY,
    cx, midY + 2,
    cx + halfW, baseY,
    NAV_FACET_R
  );

  // Left facet (lighter gray)
  gfx->fillTriangle(
    cx, tipY,
    cx, midY + 2,
    cx - halfW, baseY,
    NAV_FACET_L
  );

  // Center highlight (bright white, smaller)
  gfx->fillTriangle(
    cx, tipY + 2,
    cx - halfW + 5, baseY - 2,
    cx + halfW - 5, baseY - 2,
    NAV_ARROW
  );

  // Inner "V" cutout for chevron shape
  gfx->fillTriangle(
    cx, midY + 4,
    cx - halfW + 5, baseY,
    cx + halfW - 5, baseY,
    NAV_BG
  );
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

// ===== Draw Distance + Turn Direction (Bottom Center) =====
static void drawDistanceAndTurn(NavChunk* chunk) {
  int distY = 198;
  int turnIconX = NAV_CX - 60;
  int turnIconY = distY + 10;

  // Mini turn icon
  drawMiniTurnIcon(turnIconX, turnIconY, chunk->direction);

  // Distance number (large)
  gfx->setTextSize(3);
  gfx->setTextColor(NAV_TEXT);

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

  // Center the distance text (approx 18px per char at size 3)
  int distLen = strlen(distBuf);
  int textW = distLen * 18;
  int distX = NAV_CX - textW / 2 + 12;

  gfx->setCursor(distX, distY);
  gfx->print(distBuf);

  // Unit (smaller, beside the number)
  gfx->setTextSize(2);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(distX + textW + 4, distY + 6);
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

  // 5. Distance + turn icon (bottom center)
  drawDistanceAndTurn(chunk);

  // 6. Progress arc (very bottom)
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
      NavChunk* chunk = getCurrentNavChunk();
      drawNavScreen(chunk);
      lastNavRender = now;
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
