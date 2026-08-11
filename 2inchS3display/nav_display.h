/*
 * nav_display.h - Navigation display rendering for ESP32-S3
 * Tripper Telemetry Dashboard V5
 *
 * Renders turn-by-turn navigation with breadcrumb path on the display.
 * Dark background with white navigation graphics (compact device aesthetic).
 * Only renders when navigation is active; returns to dashboard when done.
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
#define NAV_PATH       0xFFFF   // White path/breadcrumb
#define NAV_ARROW      0xFFFF   // White arrow
#define NAV_TEXT       0xFFFF   // White text
#define NAV_DIM        0x7BCF   // Dimmed gray
#define NAV_ACCENT     0xFDA0   // Orange accent (#FFB400)
#define NAV_DISTANCE   0x2D7F   // Blue for distance

static bool navDisplayActive = false;
static unsigned long lastNavRender = 0;

// ===== Draw Turn Arrow =====
// Draws a large directional arrow based on direction code
void drawTurnArrow(int cx, int cy, const char* direction) {
  int arrowSize = 40;

  // Clear arrow area
  gfx->fillRect(cx - 50, cy - 50, 100, 100, NAV_BG);

  if (strcmp(direction, "R") == 0) {
    // Right turn arrow
    gfx->fillTriangle(cx + arrowSize, cy, cx, cy - 20, cx, cy + 20, NAV_ARROW);
    gfx->fillRect(cx - arrowSize, cy - 6, arrowSize, 12, NAV_ARROW);
    gfx->fillRect(cx - 6, cy - arrowSize, 12, arrowSize, NAV_ARROW);
  }
  else if (strcmp(direction, "L") == 0) {
    // Left turn arrow
    gfx->fillTriangle(cx - arrowSize, cy, cx, cy - 20, cx, cy + 20, NAV_ARROW);
    gfx->fillRect(cx, cy - 6, arrowSize, 12, NAV_ARROW);
    gfx->fillRect(cx - 6, cy - arrowSize, 12, arrowSize, NAV_ARROW);
  }
  else if (strcmp(direction, "U") == 0) {
    // U-turn arrow
    gfx->fillTriangle(cx - 30, cy + 10, cx - 10, cy + 10, cx - 20, cy + arrowSize, NAV_ARROW);
    gfx->drawArc(cx, cy - 10, 25, 20, 0, 180, NAV_ARROW);
  }
  else {
    // Straight arrow (default)
    gfx->fillTriangle(cx, cy - arrowSize, cx - 20, cy, cx + 20, cy, NAV_ARROW);
    gfx->fillRect(cx - 6, cy, 12, arrowSize, NAV_ARROW);
  }
}

// ===== Draw Breadcrumb Path =====
// Renders the route path segment using offset data
void drawBreadcrumbPath(NavChunk* chunk) {
  int startX = 260;
  int startY = 200;
  int prevX = startX;
  int prevY = startY;

  // Draw path from offsets
  for (int i = 0; i < chunk->pathPointCount && i < 10; i++) {
    int px = startX + chunk->pathOffsets[i * 2] * 2;
    int py = startY + chunk->pathOffsets[i * 2 + 1] * 2;

    // Draw path segment
    gfx->drawLine(prevX, prevY, px, py, NAV_PATH);
    gfx->drawLine(prevX + 1, prevY, px + 1, py, NAV_PATH);

    // Draw dot at waypoint
    gfx->fillCircle(px, py, 2, NAV_ACCENT);

    prevX = px;
    prevY = py;
  }

  // Draw current position indicator
  gfx->fillCircle(startX, startY, 5, NAV_ACCENT);
  gfx->drawCircle(startX, startY, 7, NAV_DIM);
}

// ===== Draw Navigation Screen =====
void drawNavScreen(NavChunk* chunk) {
  // Full black background
  gfx->fillScreen(NAV_BG);

  // --- Top bar: chunk progress ---
  gfx->setTextSize(1);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(8, 6);
  gfx->printf("STEP %d/%d", chunk->chunkIndex + 1, chunk->totalChunks);

  // TRIPPER branding top-right
  gfx->setTextColor(NAV_ACCENT);
  gfx->setCursor(250, 6);
  gfx->print("TRIPPER");

  // Divider line
  gfx->drawFastHLine(0, 18, SCREEN_W, NAV_DIM);

  // --- Turn direction arrow (left area) ---
  drawTurnArrow(80, 90, chunk->direction);

  // --- Distance to next instruction ---
  gfx->setTextSize(3);
  gfx->setTextColor(NAV_DISTANCE);
  gfx->setCursor(20, 155);
  if (chunk->distanceMeters >= 1000) {
    gfx->printf("%.1f", chunk->distanceMeters / 1000.0f);
    gfx->setTextSize(2);
    gfx->print(" km");
  } else {
    gfx->printf("%d", chunk->distanceMeters);
    gfx->setTextSize(2);
    gfx->print(" m");
  }

  // --- Instruction text ---
  gfx->setTextSize(2);
  gfx->setTextColor(NAV_TEXT);
  gfx->setCursor(20, 195);
  gfx->print(chunk->instruction);

  // --- Bearing indicator ---
  gfx->setTextSize(1);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(20, 225);
  gfx->printf("BRG %d", chunk->bearing);
  gfx->print("\xF8"); // degree symbol

  // --- Breadcrumb path (right side) ---
  drawBreadcrumbPath(chunk);

  // --- Bottom bar ---
  gfx->drawFastHLine(0, SCREEN_H - 16, SCREEN_W, NAV_DIM);
  gfx->setTextSize(1);
  gfx->setTextColor(NAV_ACCENT);
  gfx->setCursor(8, SCREEN_H - 12);
  gfx->print("NAVIGATING");

  if (chunk->isLast) {
    gfx->setTextColor(0x2F06); // Green
    gfx->setCursor(200, SCREEN_H - 12);
    gfx->print("ARRIVING SOON");
  }
}

// ===== Draw Navigation Complete Screen =====
void drawNavComplete() {
  gfx->fillScreen(NAV_BG);

  gfx->setTextSize(2);
  gfx->setTextColor(0x2F06); // Green
  gfx->setCursor(60, 80);
  gfx->print("DESTINATION");
  gfx->setCursor(80, 110);
  gfx->print("REACHED");

  gfx->setTextSize(1);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(60, 160);
  gfx->print("Returning to dashboard...");

  gfx->setTextColor(NAV_ACCENT);
  gfx->setCursor(120, 200);
  gfx->print("TRIPPER");
}

// ===== Enter Navigation Mode =====
void enterNavMode() {
  navDisplayActive = true;
  gfx->fillScreen(NAV_BG);

  // Waiting for first chunk
  gfx->setTextSize(2);
  gfx->setTextColor(NAV_TEXT);
  gfx->setCursor(60, 100);
  gfx->print("Starting nav...");

  gfx->setTextSize(1);
  gfx->setTextColor(NAV_DIM);
  gfx->setCursor(60, 140);
  gfx->print("Waiting for route data");
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
    if (now - lastNavRender > 500) { // Small delay before showing complete
      drawNavComplete();
      lastNavRender = now;

      // Auto-return to dashboard after 3 seconds
      static unsigned long completeTime = 0;
      if (completeTime == 0) completeTime = now;
      if (now - completeTime > 3000) {
        completeTime = 0;
        exitNavMode();
        return false; // Signal to return to dashboard
      }
    }
  }
  else if (state == NAV_IDLE && navDisplayActive) {
    // Navigation was stopped externally
    exitNavMode();
    return false;
  }

  return true; // Still in nav mode
}

#endif // NAV_DISPLAY_H
