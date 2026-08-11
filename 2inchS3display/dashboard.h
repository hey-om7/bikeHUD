/*
 * dashboard.h - All dashboard drawing and update functions
 * Tripper Telemetry Dashboard V5
 */
#ifndef DASHBOARD_H
#define DASHBOARD_H

#include <Arduino_GFX_Library.h>
#include <math.h>
#include "config.h"
#include "bike_image.h"
#include "sensors.h"

extern Arduino_GFX *gfx;
extern bool hotspotConnected;
extern bool sosArmed;

// UI Previous Values (Flicker-Free Differential Rendering)
static float prevPitch = -999.0;
static float prevAlt = -999.0;
static float prevHead = -999.0;
static int prevSats = -1;
static bool prevFix = false;
static bool prevHotspot = false;
static float dummyHeadingOffset = 0.0f;

// ===== Rendering Helpers =====
void drawThickLine(int x0, int y0, int x1, int y1, int thickness, uint16_t color) {
  float dx = x1 - x0;
  float dy = y1 - y0;
  float len = sqrtf(dx * dx + dy * dy);
  if (len < 0.5f) { gfx->drawPixel(x0, y0, color); return; }
  float nx = -dy / len;
  float ny = dx / len;
  for (int i = -(thickness / 2); i <= thickness / 2; i++) {
    gfx->drawLine(x0 + (int)(nx * i), y0 + (int)(ny * i),
                  x1 + (int)(nx * i), y1 + (int)(ny * i), color);
  }
}

void drawPanel(int x, int y, int w, int h, uint16_t fillColor, uint16_t borderColor) {
  gfx->fillRoundRect(x, y, w, h, 4, fillColor);
  gfx->drawRoundRect(x, y, w, h, 4, borderColor);
}

// ===== Motorcycle Image =====
void drawMotorcycleImage(int ox, int oy) {
  gfx->draw16bitRGBBitmap(ox, oy, bike_image, BIKE_WIDTH, BIKE_HEIGHT);
}

// ===== Static UI Drawing =====
void drawStaticUI() {
  gfx->fillRect(0, 0, SCREEN_W, SCREEN_H / 2, COL_BG_DARK);
  gfx->fillRect(0, SCREEN_H / 2, SCREEN_W, SCREEN_H / 2, COL_BG_MID);

  int capW = 94, capH = SBAR_CAPSULE_H, capY = SBAR_Y;
  int gap = 5, startX = 4;

  // SOS capsule
  uint16_t sosBg = sosArmed ? COL_GREEN : COL_GRAY_DIM;
  gfx->fillRoundRect(startX, capY, capW, capH, 4, sosBg);
  gfx->setTextColor(sosArmed ? COL_BLACK : COL_GRAY_MID);
  gfx->setTextSize(2);
  gfx->setCursor(startX + (capW - 36) / 2, capY + 2);
  gfx->print("SOS");
  gfx->setTextSize(1);

  // PAIRED capsule
  int cap2X = startX + capW + gap;
  uint16_t pairedBg = hotspotConnected ? COL_BLUE : COL_GRAY_DIM;
  gfx->fillRoundRect(cap2X, capY, capW, capH, 4, pairedBg);
  gfx->setTextColor(hotspotConnected ? COL_BLACK : COL_GRAY_MID);
  gfx->setTextSize(2);
  gfx->setCursor(cap2X + 11, capY + 2);
  gfx->print("PAIRED");
  gfx->setTextSize(1);

  // GPS capsule - circles
  int cap3X = cap2X + capW + gap;
  drawPanel(cap3X, capY, capW, capH, COL_PANEL, COL_ORANGE_DIM);
  int circleY = capY + capH / 2;
  int circleR = 3, circleSpacing = 12;
  int circlesStartX = cap3X + (capW - (3 * circleSpacing)) / 2;
  int strength = min(gpsSatellites / 2, 4);
  for (int i = 0; i < 4; i++) {
    int cx = circlesStartX + i * circleSpacing;
    if (i < strength) gfx->fillCircle(cx, circleY, circleR, COL_ORANGE);
    else gfx->drawCircle(cx, circleY, circleR, COL_BORDER);
  }
}

// ===== Draw Compass Panel =====
void drawCompassStatic() {
  drawPanel(COMP_X, COMP_Y, COMP_W, COMP_H, COL_PANEL, COL_BORDER);
  int cx = COMP_CX, cy = COMP_CY, cr = COMP_R;
  gfx->drawCircle(cx, cy, cr, COL_RING_METAL);
  gfx->drawCircle(cx, cy, cr - 1, COL_BORDER);
  gfx->drawCircle(cx, cy, cr - 2, COL_RING_METAL);
  gfx->fillCircle(cx, cy, cr - 3, COL_GAUGE_BG);
  gfx->drawCircle(cx, cy, cr - 3, COL_BORDER);
  int arrowTipY = cy - cr - 4;
  int arrowBaseY = arrowTipY + 6;
  gfx->fillTriangle(cx, arrowTipY, cx - 4, arrowBaseY, cx + 4, arrowBaseY, COL_ORANGE);
}

// ===== Draw Incline + Motorcycle Panel =====
void drawInclineStatic() {
  drawPanel(INCL_X, INCL_Y, INCL_W, INCL_H, COL_PANEL, COL_BORDER);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_GRAY_MID);
  gfx->setCursor(INCL_X + 6, INCL_Y + 4);
  gfx->print("INCLINE");

  int icx = INCL_CX, icy = INCL_CY, ir = INCL_R;
  for (float a = -90.0f; a <= 90.0f; a += 0.6f) {
    float rad = (a - 90) * DEG2RAD;
    int px = icx + (int)(ir * cosf(rad));
    int py = icy + (int)(ir * sinf(rad));
    if (py >= INCL_Y + 16 && py <= INCL_Y + INCL_H - 44)
      gfx->drawPixel(px, py, COL_TICK_DIM);
    px = icx + (int)((ir - 1) * cosf(rad));
    py = icy + (int)((ir - 1) * sinf(rad));
    if (py >= INCL_Y + 16 && py <= INCL_Y + INCL_H - 44)
      gfx->drawPixel(px, py, COL_BORDER);
  }

  for (int a = -45; a <= 45; a += 15) {
    float screenAngle = (float)a * 2.0f;
    float rad = (screenAngle - 90) * DEG2RAD;
    int innerR = (a == 0) ? ir - 12 : ir - 8;
    int outerR = ir - 2;
    int x0 = icx + (int)(innerR * cosf(rad));
    int y0 = icy + (int)(innerR * sinf(rad));
    int x1 = icx + (int)(outerR * cosf(rad));
    int y1 = icy + (int)(outerR * sinf(rad));
    if (y0 >= INCL_Y + 14 && y1 >= INCL_Y + 14) {
      uint16_t tickCol = (a == 0) ? COL_TEXT_DARK : COL_TICK_BRIGHT;
      gfx->drawLine(x0, y0, x1, y1, tickCol);
      if (a == 0) gfx->drawLine(x0 + 1, y0, x1 + 1, y1, tickCol);
    }
  }

  gfx->setTextColor(COL_GRAY_DIM);
  gfx->setTextSize(1);
  gfx->setCursor(INCL_X + 8, INCL_Y + 42);
  gfx->print("-45");
  gfx->setCursor(INCL_X + INCL_W - 24, INCL_Y + 42);
  gfx->print("+45");

  gfx->fillCircle(icx, icy, 3, COL_RING_METAL);
  gfx->fillCircle(icx, icy, 1, COL_TEXT_DARK);

  drawMotorcycleImage(INCL_X + 18, INCL_Y + 54);

  gfx->setTextColor(COL_ORANGE);
  gfx->setTextSize(1);
  gfx->setCursor(INCL_X + 8, INCL_Y + INCL_H - 10);
  gfx->print("TRIPPER");
  gfx->setTextColor(COL_GRAY_DIM);
  gfx->setCursor(INCL_X + 56, INCL_Y + INCL_H - 10);
  gfx->print("READY TO RACE");
}

// ===== Draw Center Information Area =====
void drawCenterStatic() {
  gfx->fillRoundRect(CTR_X, CTR_Y, CTR_W - 22, CTR_H, 4, COL_PANEL);
  gfx->drawRoundRect(CTR_X, CTR_Y, CTR_W - 22, CTR_H, 4, COL_BORDER);
  gfx->setTextColor(COL_GRAY_MID);
  gfx->setTextSize(1);
  gfx->setCursor(CTR_X + 8, CTR_Y + 6);
  gfx->print("HEADING");
  gfx->setCursor(CTR_X + 8, CTR_Y + 80);
  gfx->print("ALTITUDE");
  gfx->setCursor(CTR_X + 8, CTR_Y + 140);
  gfx->print("SATELLITES");
  gfx->drawFastHLine(CTR_X + 6, CTR_Y + 72, CTR_W - 36, COL_BORDER);
  gfx->drawFastHLine(CTR_X + 6, CTR_Y + 132, CTR_W - 36, COL_BORDER);
  gfx->drawFastHLine(CTR_X + 6, CTR_Y + 186, CTR_W - 36, COL_BORDER);
  gfx->setTextColor(COL_GRAY_DIM);
  gfx->setCursor(CTR_X + 8, CTR_Y + 194);
  gfx->print("STATUS");
}

// ===== Draw Elevation Strip =====
void drawElevationStatic() {
  int ex = ELEV_X, ey = ELEV_Y, ew = ELEV_W, eh = ELEV_H;
  gfx->fillRect(ex, ey, ew, eh, COL_PANEL);
  gfx->drawRect(ex, ey, ew, eh, COL_BORDER);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_TEXT_MID);
  gfx->setCursor(ex + 7, ey + 3);
  gfx->print("m");

  int scaleTop = ey + 16, scaleBot = ey + eh - 22;
  int scaleH = scaleBot - scaleTop;
  int trackX = ex + 12, trackW = 5;
  gfx->fillRect(trackX, scaleTop, trackW, scaleH, COL_BORDER_DIM);
  gfx->drawRect(trackX, scaleTop, trackW, scaleH, COL_BORDER);

  for (int alt = 0; alt <= 2500; alt += 500) {
    int tickY = scaleBot - (int)((float)alt / MAX_ALTITUDE * scaleH);
    gfx->drawFastHLine(ex + 2, tickY, 9, COL_TICK_BRIGHT);
    if (alt == 0 || alt == 1000 || alt == 2000) {
      char lb[4]; snprintf(lb, sizeof(lb), "%d", alt / 1000);
      gfx->setTextColor(COL_TEXT_MID);
      gfx->setCursor(ex + 3, tickY - 9);
      gfx->print(lb);
    }
  }
  for (int alt = 250; alt < 2500; alt += 500) {
    int tickY = scaleBot - (int)((float)alt / MAX_ALTITUDE * scaleH);
    gfx->drawFastHLine(ex + 4, tickY, 6, COL_TICK_DIM);
  }
}


// ===== Dynamic Update: Header Bar =====
void updateHeaderBar() {
  gfx->setTextSize(1);
  int capW = 94, capH = SBAR_CAPSULE_H, capY = SBAR_Y;
  int gap = 5, startX = 4;

  uint16_t sosBg = sosArmed ? COL_GREEN : COL_GRAY_DIM;
  gfx->fillRoundRect(startX, capY, capW, capH, 4, sosBg);
  gfx->setTextColor(sosArmed ? COL_BLACK : COL_GRAY_MID);
  gfx->setTextSize(2);
  gfx->setCursor(startX + (capW - 36) / 2, capY + 2);
  gfx->print("SOS");
  gfx->setTextSize(1);

  int cap2X = startX + capW + gap;
  uint16_t pairedBg = hotspotConnected ? COL_BLUE : COL_GRAY_DIM;
  gfx->fillRoundRect(cap2X, capY, capW, capH, 4, pairedBg);
  gfx->setTextColor(hotspotConnected ? COL_BLACK : COL_GRAY_MID);
  gfx->setTextSize(2);
  gfx->setCursor(cap2X + 11, capY + 2);
  gfx->print("PAIRED");
  gfx->setTextSize(1);

  int cap3X = cap2X + capW + gap;
  uint16_t gpsAccent = gpsFix ? COL_ORANGE_DIM : COL_BORDER;
  gfx->fillRoundRect(cap3X + 1, capY + 1, capW - 2, capH - 2, 3, COL_PANEL);
  gfx->drawRoundRect(cap3X, capY, capW, capH, 4, gpsAccent);
  int circleY = capY + capH / 2;
  int circleR = 3, circleSpacing = 12;
  int circlesStartX = cap3X + (capW - (3 * circleSpacing)) / 2;
  int strength = min(gpsSatellites / 2, 4);
  for (int i = 0; i < 4; i++) {
    int cx = circlesStartX + i * circleSpacing;
    if (i < strength) gfx->fillCircle(cx, circleY, circleR, COL_ORANGE);
    else gfx->drawCircle(cx, circleY, circleR, COL_BORDER);
  }
}

// ===== Dynamic Update: Compass (Rotating Ring) =====
void updateCompassCard(float heading) {
  int cx = COMP_CX, cy = COMP_CY, cr = COMP_R;
  gfx->fillCircle(cx, cy, cr - 3, COL_GAUGE_BG);
  gfx->drawCircle(cx, cy, cr - 3, COL_BORDER);

  float offset = -heading;
  for (int a = 0; a < 360; a += 30) {
    float dispAngle = a + offset;
    float rad = (dispAngle - 90) * DEG2RAD;
    int innerR = (a % 90 == 0) ? cr - 16 : cr - 11;
    int outerR = cr - 5;
    int x0 = cx + (int)(innerR * cosf(rad));
    int y0 = cy + (int)(innerR * sinf(rad));
    int x1 = cx + (int)(outerR * cosf(rad));
    int y1 = cy + (int)(outerR * sinf(rad));
    uint16_t tickCol = (a % 90 == 0) ? COL_TICK_BRIGHT : COL_TICK_DIM;
    gfx->drawLine(x0, y0, x1, y1, tickCol);
    if (a % 90 == 0) gfx->drawLine(x0 + 1, y0, x1 + 1, y1, tickCol);
  }
  for (int a = 15; a < 360; a += 30) {
    float dispAngle = a + offset;
    float rad = (dispAngle - 90) * DEG2RAD;
    int innerR = cr - 8, outerR = cr - 5;
    int x0 = cx + (int)(innerR * cosf(rad));
    int y0 = cy + (int)(innerR * sinf(rad));
    int x1 = cx + (int)(outerR * cosf(rad));
    int y1 = cy + (int)(outerR * sinf(rad));
    gfx->drawLine(x0, y0, x1, y1, COL_TICK_DIM);
  }

  int labelR = cr - 24;
  gfx->setTextSize(2);
  float nAngle = (0 + offset - 90) * DEG2RAD;
  gfx->setTextColor(COL_RED);
  gfx->setCursor(cx + (int)(labelR * cosf(nAngle)) - 5, cy + (int)(labelR * sinf(nAngle)) - 7);
  gfx->print("N");
  float eAngle = (90 + offset - 90) * DEG2RAD;
  gfx->setTextColor(COL_TEXT_DARK);
  gfx->setCursor(cx + (int)(labelR * cosf(eAngle)) - 5, cy + (int)(labelR * sinf(eAngle)) - 7);
  gfx->print("E");
  float sAngle = (180 + offset - 90) * DEG2RAD;
  gfx->setCursor(cx + (int)(labelR * cosf(sAngle)) - 5, cy + (int)(labelR * sinf(sAngle)) - 7);
  gfx->print("S");
  float wAngle = (270 + offset - 90) * DEG2RAD;
  gfx->setCursor(cx + (int)(labelR * cosf(wAngle)) - 6, cy + (int)(labelR * sinf(wAngle)) - 7);
  gfx->print("W");
  gfx->setTextSize(1);

  gfx->fillCircle(cx, cy, 3, COL_RING_METAL);
  gfx->fillCircle(cx, cy, 1, COL_TEXT_DARK);
}

// ===== Dynamic Update: Incline Gauge =====
void updateInclineCard(float pitch) {
  int icx = INCL_CX, icy = INCL_CY, ir = INCL_R;
  int needleR = ir - 6;

  if (prevPitch > -900) {
    float prevAngle = constrain(prevPitch, -45.0f, 45.0f) * 2.0f;
    float oRad = (prevAngle - 90) * DEG2RAD;
    int tipX = icx + (int)(needleR * cosf(oRad));
    int tipY = icy + (int)(needleR * sinf(oRad));
    drawThickLine(icx, icy, tipX, tipY, 2, COL_PANEL);
    int tL_x = icx + (int)(4 * cosf(oRad - 0.3f));
    int tL_y = icy + (int)(4 * sinf(oRad - 0.3f));
    int tR_x = icx + (int)(4 * cosf(oRad + 0.3f));
    int tR_y = icy + (int)(4 * sinf(oRad + 0.3f));
    gfx->fillTriangle(tipX, tipY, tL_x, tL_y, tR_x, tR_y, COL_PANEL);
  }

  gfx->fillRect(INCL_X + 60, INCL_Y + 2, 64, 14, COL_PANEL);
  uint16_t valColor = (fabsf(pitch) > 15.0f) ? COL_AMBER : COL_TEXT_DARK;
  gfx->setTextColor(valColor);
  gfx->setTextSize(1);
  gfx->setCursor(INCL_X + 62, INCL_Y + 4);
  char incBuf[12]; snprintf(incBuf, sizeof(incBuf), "%+.1f", pitch);
  gfx->print(incBuf);
  gfx->setTextColor(COL_GRAY_MID);
  gfx->print("\xF8");

  float angle = constrain(pitch, -45.0f, 45.0f) * 2.0f;
  float nRad = (angle - 90) * DEG2RAD;
  int tipX = icx + (int)(needleR * cosf(nRad));
  int tipY = icy + (int)(needleR * sinf(nRad));
  drawThickLine(icx, icy, tipX, tipY, 2, COL_TEXT_DARK);
  int tL_x = icx + (int)(4 * cosf(nRad - 0.3f));
  int tL_y = icy + (int)(4 * sinf(nRad - 0.3f));
  int tR_x = icx + (int)(4 * cosf(nRad + 0.3f));
  int tR_y = icy + (int)(4 * sinf(nRad + 0.3f));
  gfx->fillTriangle(tipX, tipY, tL_x, tL_y, tR_x, tR_y, valColor);
  gfx->fillCircle(icx, icy, 3, COL_RING_METAL);
  gfx->fillCircle(icx, icy, 1, COL_TEXT_DARK);
}

// ===== Dynamic Update: Center Information =====
void updateCenterInfo() {
  int px = CTR_X + 8;
  int panelW = CTR_W - 36;

  gfx->fillRect(px, CTR_Y + 18, panelW, 44, COL_PANEL);
  gfx->setTextColor(COL_TEXT_DARK);
  gfx->setTextSize(3);
  gfx->setCursor(px + 4, CTR_Y + 22);
  char headBuf[8]; snprintf(headBuf, sizeof(headBuf), "%03d", (int)gpsHeading);
  gfx->print(headBuf);
  gfx->setTextSize(1);
  gfx->setCursor(px + 58, CTR_Y + 22);
  gfx->print("\xF8");
  gfx->setTextColor(COL_ORANGE);
  gfx->setTextSize(2);
  gfx->setCursor(px + 66, CTR_Y + 26);
  gfx->print(getCardinalDirection(gpsHeading));

  gfx->fillRect(px, CTR_Y + 92, panelW, 34, COL_PANEL);
  gfx->setTextColor(COL_TEXT_DARK);
  gfx->setTextSize(3);
  gfx->setCursor(px + 4, CTR_Y + 94);
  gfx->printf("%d", (int)gpsAltitude);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_GRAY_MID);
  gfx->setCursor(px + 68, CTR_Y + 108);
  gfx->print("m MSL");

  gfx->fillRect(px, CTR_Y + 152, panelW, 26, COL_PANEL);
  gfx->setTextColor(COL_TEXT_DARK);
  gfx->setTextSize(2);
  gfx->setCursor(px + 4, CTR_Y + 154);
  gfx->printf("%02d", gpsSatellites);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_GRAY_MID);
  gfx->setCursor(px + 32, CTR_Y + 158);
  gfx->print(gpsFix ? "3D FIX" : "NO FIX");

  gfx->fillRect(px, CTR_Y + 200, panelW, 12, COL_PANEL);
  gfx->setTextSize(1);
  gfx->setTextColor(imuConnected ? COL_GREEN : COL_GRAY_DIM);
  gfx->setCursor(px, CTR_Y + 202);
  gfx->print(imuConnected ? "IMU OK" : "IMU --");
  gfx->setTextColor(gpsFix ? COL_GREEN : COL_GRAY_DIM);
  gfx->setCursor(px + 50, CTR_Y + 202);
  gfx->print(gpsFix ? "GPS OK" : "GPS --");
}

// ===== Dynamic Update: Elevation Strip =====
void updateElevationStrip(float alt) {
  int ex = ELEV_X, ey = ELEV_Y, ew = ELEV_W, eh = ELEV_H;
  int scaleTop = ey + 16, scaleBot = ey + eh - 22;
  int scaleH = scaleBot - scaleTop;
  float altCapped = constrain(alt, 0.0f, MAX_ALTITUDE);
  int fillH = (int)((altCapped / MAX_ALTITUDE) * scaleH);
  int trackX = ex + 12, trackW = 5;

  gfx->fillRect(trackX, scaleTop, trackW, scaleH, COL_BORDER_DIM);
  if (fillH > 0) gfx->fillRect(trackX, scaleBot - fillH, trackW, fillH, COL_ORANGE);

  int pointerY = scaleBot - fillH;
  if (pointerY >= scaleTop && pointerY <= scaleBot)
    gfx->fillTriangle(ex + 2, pointerY, ex + 8, pointerY - 3, ex + 8, pointerY + 3, COL_ORANGE);

  gfx->drawRect(trackX, scaleTop, trackW, scaleH, COL_BORDER);

  gfx->fillRect(ex + 1, ey + eh - 20, ew - 2, 18, COL_PANEL);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_TEXT_DARK);
  char altBuf[6]; snprintf(altBuf, sizeof(altBuf), "%d", (int)alt);
  int textW = strlen(altBuf) * 6;
  gfx->setCursor(ex + (ew - textW) / 2, ey + eh - 16);
  gfx->print(altBuf);
}

// ===== Draw Full Dashboard =====
void initDashboard() {
  drawStaticUI();
  drawCompassStatic();
  drawInclineStatic();
  drawCenterStatic();
  drawElevationStatic();
  updateHeaderBar();
  updateCompassCard(gpsHeading);
  updateInclineCard(pitchIncline);
  updateCenterInfo();
  updateElevationStrip(gpsAltitude);
}

// ===== Dashboard Loop Update =====
void updateDashboard() {
  if (fabsf(pitchIncline - prevPitch) >= 0.2f) {
    updateInclineCard(pitchIncline);
    prevPitch = pitchIncline;
  }

  dummyHeadingOffset += 0.5f;
  if (dummyHeadingOffset >= 360.0f) dummyHeadingOffset -= 360.0f;
  float displayHeading = gpsHeading + dummyHeadingOffset;
  if (displayHeading >= 360.0f) displayHeading -= 360.0f;
  if (fabsf(displayHeading - prevHead) >= 1.0f) {
    updateCompassCard(displayHeading);
    prevHead = displayHeading;
  }

  if (fabsf(gpsAltitude - prevAlt) >= 1.0f) {
    updateElevationStrip(gpsAltitude);
    updateCenterInfo();
    prevAlt = gpsAltitude;
  }

  if (gpsSatellites != prevSats || gpsFix != prevFix || hotspotConnected != prevHotspot) {
    updateHeaderBar();
    updateCenterInfo();
    prevSats = gpsSatellites;
    prevFix = gpsFix;
    prevHotspot = hotspotConnected;
  }
}

#endif // DASHBOARD_H
