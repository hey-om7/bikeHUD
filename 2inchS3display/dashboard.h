/*
 * dashboard.h - Full Dashboard Render and Dynamic Widget Updates
 *
 * Rendering model
 * ---------------
 * All dynamic values live in a single `DashboardData` struct. The main loop
 * fills it each frame and calls `updateDashboard(data)`.
 *
 * Each on-screen value is a `ValueWidget`. A widget caches the last string it
 * drew and its exact pixel footprint. On update it:
 *   - skips entirely if the value hasn't changed (no flicker, no wasted SPI),
 *   - otherwise clears ONLY its own previous footprint and redraws.
 * This gives clean partial refreshes: the background image and every other
 * widget are left untouched.
 *
 * Adding a new value (e.g. AQI / UV from an API):
 *   1. add a field to `DashboardData`
 *   2. declare a `ValueWidget` with its screen position
 *   3. add one `updateValueWidget(...)` line inside `updateDashboard`
 *   4. set the field from your data source in the main loop
 */
#ifndef DASHBOARD_H
#define DASHBOARD_H

#include <Arduino_GFX_Library.h>
#include "config.h"
#include "dashboard_bg.h"  // Full-screen background bitmap: dashboard_bg_bitmap
#include "sensors.h"
#include "Inter_Black_16pt.h"
#include "Inter_Black12pt.h"
#include "Inter_Black8pt.h"

extern Arduino_GFX *gfx;
extern bool hotspotConnected;
extern bool sosArmed;

// Text color for all dynamic values. Backgrounds are no longer painted as a
// solid color: each widget restores the real background image underneath, so
// values blend into gradients/cards instead of sitting in white boxes.
#define TEXT_COLOR 0x0000  // Black text

// =========================================================================
// DASHBOARD DATA MODEL
// Single source of truth for every dynamic value on the dashboard.
// A value of -1 on an int metric means "not available yet" and renders as "--".
// =========================================================================
struct DashboardData {
  float speed;              // km/h
  float dist;               // km
  float altitude;           // m
  float heading;            // degrees
  float pitch;              // degrees
  int   temp;               // deg C (ESP internal sensor for now)
  int   aqi;                // Air Quality Index   (-1 = not ready)
  int   wind;               // wind speed          (-1 = not ready)
  int   uv;                 // UV index            (-1 = not ready)
  unsigned long timeOnSec;  // seconds since boot (stopwatch)

  DashboardData()
    : speed(0), dist(0), altitude(0), heading(0), pitch(0),
      temp(0), aqi(-1), wind(-1), uv(-1), timeOnSec(0) {}
};

// =========================================================================
// VALUE WIDGET
// A single value region that redraws only when its text changes.
// =========================================================================
struct ValueWidget {
  // Layout (fixed)
  int16_t x, y;              // draw origin (top-left baseline used by GFX fonts)
  const GFXfont *font;       // main value font
  const char *suffix;        // optional unit suffix ("km", "m", "o"); "" = none
  const GFXfont *suffixFont; // font for the suffix
  int16_t gap;               // pixels between value and suffix
  bool alignTop;             // align suffix to top (true) or bottom (false)

  // Cache (managed internally)
  String   lastText;
  int16_t  clrX, clrY;       // previous footprint to clear on next redraw
  uint16_t clrW, clrH;
  bool     drawn;

  ValueWidget(int16_t x_, int16_t y_, const GFXfont *font_,
              const char *suffix_ = "", const GFXfont *suffixFont_ = nullptr,
              int16_t gap_ = 0, bool alignTop_ = true)
    : x(x_), y(y_), font(font_), suffix(suffix_), suffixFont(suffixFont_),
      gap(gap_), alignTop(alignTop_),
      lastText(""), clrX(0), clrY(0), clrW(0), clrH(0), drawn(false) {}
};

// =========================================================================
// WIDGET INSTANCES (positions tuned for the 320x240 dashboard background)
// =========================================================================
static ValueWidget wDist(5,   50,  &Inter_Black_16pt, "km", &Inter_Black8pt, 10, true);
// Time split into H : M : S so only the changed segment redraws (no blink).
// Positions follow the font's natural advances (digit=22px, colon=12px) so the
// split clock looks identical to a single "00:00:00" string with no extra gaps.
static ValueWidget wTimeH(5,   230, &Inter_Black_16pt);
static ValueWidget wTimeM(61,  230, &Inter_Black_16pt);
static ValueWidget wTimeS(117, 230, &Inter_Black_16pt);
static ValueWidget wAqi (250, 60,  &Inter_Black_16pt);
static ValueWidget wWind(270, 120, &Inter_Black_16pt);
static ValueWidget wTemp(260, 175, &Inter_Black_16pt, "o", &Inter_Black8pt, 3, true);
static ValueWidget wAlt (210, 230, &Inter_Black_16pt, "m", &Inter_Black8pt, 3, false);
// To add UV, give it a position and uncomment its update line below:
// static ValueWidget wUv(70, 150, &Inter_Black_16pt);

// =========================================================================
// FORMAT HELPERS
// =========================================================================

// Renders a metric, or "--" while the value is still unavailable (sentinel < 0).
String formatMetric(int value) {
  if (value < 0) return String("--");
  return String(value);
}

// =========================================================================
// RENDERING
// =========================================================================

// Repaints a rectangular slice of the original background image. Used to erase
// a widget's previous value without leaving a solid-color box: the true pixels
// underneath (gradients, cards, art) are copied back from dashboard_bg_bitmap.
void restoreBackground(int16_t x, int16_t y, int16_t w, int16_t h) {
  if (w <= 0 || h <= 0) return;

  // Clamp to the screen so we never index outside the bitmap.
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > SCREEN_W) w = SCREEN_W - x;
  if (y + h > SCREEN_H) h = SCREEN_H - y;
  if (w <= 0 || h <= 0) return;

  // draw16bitRGBBitmap can render a sub-region by giving it a pointer to the
  // start of the slice and using SCREEN_W as the full source-bitmap width.
  // However, the Arduino_GFX overload that takes a sub-rectangle isn't always
  // available, so we use the simplest safe approach: draw row-by-row.
  for (int16_t row = 0; row < h; row++) {
    const uint16_t *src = &dashboard_bg_bitmap[(uint32_t)(y + row) * SCREEN_W + x];
    gfx->draw16bitRGBBitmap(x, y + row, src, w, 1);
  }
}

// Draws a widget's value (plus optional suffix) and reports the combined pixel
// footprint via the out params so it can be cleared on the next redraw.
void renderValue(ValueWidget &w, const String &text,
                 int16_t &ox, int16_t &oy, uint16_t &ow, uint16_t &oh) {
  gfx->setTextSize(1);
  gfx->setTextColor(TEXT_COLOR);  // transparent background: glyphs sit on the art

  // ---- Main value ----
  gfx->setFont(w.font);
  int16_t mx, my;
  uint16_t mw, mh;
  gfx->getTextBounds(text, w.x, w.y, &mx, &my, &mw, &mh);
  gfx->setCursor(w.x, w.y);
  gfx->print(text);

  int16_t x1 = mx, y1 = my;
  int16_t x2 = mx + (int16_t)mw, y2 = my + (int16_t)mh;

  // ---- Optional suffix ----
  if (w.suffix && w.suffix[0] != '\0' && w.suffixFont) {
    gfx->setFont(w.suffixFont);
    int16_t sx = w.x + (int16_t)mw + w.gap;

    int16_t sbx, sby;
    uint16_t sbw, sbh;
    gfx->getTextBounds(w.suffix, sx, w.y, &sbx, &sby, &sbw, &sbh);

    int16_t sy;
    if (w.alignTop) {
      sy = w.y + (my - sby);  // align tops
    } else {
      sy = w.y + ((my + (int16_t)mh) - (sby + (int16_t)sbh));  // align bottoms
    }

    // Recompute bounds at the final baseline for an accurate footprint.
    gfx->getTextBounds(w.suffix, sx, sy, &sbx, &sby, &sbw, &sbh);
    gfx->setCursor(sx, sy);
    gfx->print(w.suffix);

    if (sbx < x1) x1 = sbx;
    if (sby < y1) y1 = sby;
    if (sbx + (int16_t)sbw > x2) x2 = sbx + (int16_t)sbw;
    if (sby + (int16_t)sbh > y2) y2 = sby + (int16_t)sbh;
  }

  ox = x1;
  oy = y1;
  ow = (uint16_t)(x2 - x1);
  oh = (uint16_t)(y2 - y1);
}

// Change-detecting update: redraws only if the value differs, restoring just
// this widget's own previous footprint from the background image first.
void updateValueWidget(ValueWidget &w, const String &text) {
  if (w.drawn && text == w.lastText) return;  // unchanged -> nothing to do

  if (w.drawn) {
    restoreBackground(w.clrX, w.clrY, w.clrW, w.clrH);
  }

  int16_t bx, by;
  uint16_t bw, bh;
  renderValue(w, text, bx, by, bw, bh);

  w.lastText = text;
  w.clrX = bx;
  w.clrY = by;
  w.clrW = bw;
  w.clrH = bh;
  w.drawn = true;
}

// Forces every widget to redraw on the next update. Call after the background
// is repainted (e.g. returning from navigation mode) so cached "unchanged"
// values don't leave widgets blank.
void resetDashboardWidgets() {
  wDist.drawn  = false;
  wTimeH.drawn = false;
  wTimeM.drawn = false;
  wTimeS.drawn = false;
  wAqi.drawn   = false;
  wWind.drawn  = false;
  wTemp.drawn  = false;
  wAlt.drawn   = false;
  // wUv.drawn = false;
}

// =========================================================================
// ENTRY POINTS
// =========================================================================
void initDashboard() {
  // 1. Clear screen
  gfx->fillScreen(0x0000);

  // 2. Draw the static dashboard background image (matches SCREEN_W x SCREEN_H)
  gfx->draw16bitRGBBitmap(0, 0, dashboard_bg_bitmap, SCREEN_W, SCREEN_H);

  // 3. Draw static time separators (colons between HH : MM : SS).
  //    Placed in the gaps between the digit slots so the digit widgets never
  //    paint over them. These never change, so they are drawn once here.
  gfx->setFont(&Inter_Black_16pt);
  gfx->setTextSize(1);
  gfx->setTextColor(TEXT_COLOR);
  gfx->setCursor(49, 230);   // right after hours, before minutes (natural advance)
  gfx->print(":");
  gfx->setCursor(105, 230);  // right after minutes, before seconds (natural advance)
  gfx->print(":");

  // 4. The background just wiped all widget text; force a full redraw next tick.
  resetDashboardWidgets();

  // 5. Default text properties
  gfx->setTextSize(2);
  gfx->setTextColor(TEXT_COLOR);
}

// Updates all dynamic widgets from the shared data model. Cheap to call every
// frame: unchanged widgets are skipped, changed ones refresh only their region.
void updateDashboard(const DashboardData &d) {
  // Distance (km)
  char distBuf[16];
  snprintf(distBuf, sizeof(distBuf), "%.1f", d.dist);
  updateValueWidget(wDist, distBuf);

  // Time on - stopwatch since boot, split into H:M:S so only the changed
  // segment redraws (seconds tick without blinking hours/minutes).
  unsigned long h = d.timeOnSec / 3600;
  unsigned long m = (d.timeOnSec % 3600) / 60;
  unsigned long s = d.timeOnSec % 60;
  char timeBuf[4];
  snprintf(timeBuf, sizeof(timeBuf), "%02lu", h);
  updateValueWidget(wTimeH, timeBuf);
  snprintf(timeBuf, sizeof(timeBuf), "%02lu", m);
  updateValueWidget(wTimeM, timeBuf);
  snprintf(timeBuf, sizeof(timeBuf), "%02lu", s);
  updateValueWidget(wTimeS, timeBuf);

  // AQI (shows "--" until the API is wired up)
  updateValueWidget(wAqi, formatMetric(d.aqi));

  // Wind (shows "--" until available)
  updateValueWidget(wWind, formatMetric(d.wind));

  // Temperature (deg C)
  updateValueWidget(wTemp, String(d.temp));

  // Altitude (m)
  char altBuf[16];
  snprintf(altBuf, sizeof(altBuf), "%d", (int)d.altitude);
  updateValueWidget(wAlt, altBuf);

  // UV (uncomment once wUv has a position and d.uv is fed from the API):
  // updateValueWidget(wUv, formatMetric(d.uv));
}

#endif  // DASHBOARD_H
