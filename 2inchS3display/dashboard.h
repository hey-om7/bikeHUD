/*
 * dashboard.h - Full Dashboard Render and Dynamic Text Update
 */
#ifndef DASHBOARD_H
#define DASHBOARD_H

#include <Arduino_GFX_Library.h>
#include "config.h"
#include "dashboard_bg.h"  // Contains your new full-screen bitmap: dashboard_bg_bitmap
#include "sensors.h"
#include "Inter_Black_16pt.h"
#include "Inter_Black12pt.h"
#include "Inter_Black8pt.h"

extern Arduino_GFX *gfx;
extern bool hotspotConnected;
extern bool sosArmed;

// ===== Dummy Variables for State Tracking =====
// Tracking previous values prevents flickering by only redrawing when necessary
static float prevPitch = -999.0;
static float prevAlt = -999.0;
static float prevHead = -999.0;
static float prevSpeed = -1.0;
static float prevDist = -1.0;
static int prevTemp = -999;
static int prevAqi = -1;
static int prevWind = -1;
static int prevUv = -1;

// Define your text background color (matches the off-white of the UI cards)
// Adjust this hex if the card background isn't pure white (e.g., 0xF7BE)
#define CARD_BG_COLOR 0xFFFF
#define TEXT_COLOR 0x0000  // Black text

// =========================================================================
// TEXT COORDINATES (Adjust these based on your exact display resolution)
// =========================================================================
#define POS_TIME_X 600
#define POS_TIME_Y 50

#define POS_DIST_X 70
#define POS_DIST_Y 180

#define POS_SPEED_X 70
#define POS_SPEED_Y 280

#define POS_AQI_X 70
#define POS_AQI_Y 400

#define POS_WIND_X 70
#define POS_WIND_Y 460

#define POS_UV_X 70
#define POS_UV_Y 520

#define POS_TEMP_X 650
#define POS_TEMP_Y 520

#define POS_HEADING_X 350
#define POS_HEADING_Y 200

#define POS_PITCH_X 380
#define POS_PITCH_Y 450

// =========================================================================
// MAIN EXPOSED ENTRY POINTS
// =========================================================================

void initDashboard() {
  // 1. Clear screen
  gfx->fillScreen(0x0000);

  // 2. Draw the static dashboard background image
  // Assuming the image matches your SCREEN_W and SCREEN_H
  gfx->draw16bitRGBBitmap(0, 0, dashboard_bg_bitmap, SCREEN_W, SCREEN_H);

  // 3. Set text properties
  gfx->setTextSize(2);                           // Adjust text size based on your font
  gfx->setTextColor(TEXT_COLOR, CARD_BG_COLOR);  // Using BG color prevents ghosting
}

void drawTextWithSuffix(
  const String &firstText,
  const String &secondText,
  const GFXfont *firstFont,
  const GFXfont *secondFont,
  int16_t x,
  int16_t y,
  int16_t gap,
  bool alignTop) {
  // ---- First text ----
  gfx->setFont(firstFont);
  gfx->setTextSize(1);
  gfx->setTextColor(0x0000);

  int16_t firstX, firstY;
  uint16_t firstWidth, firstHeight;

  gfx->getTextBounds(
    firstText,
    x,
    y,
    &firstX,
    &firstY,
    &firstWidth,
    &firstHeight);

  // Draw first text
  gfx->setCursor(x, y);
  gfx->print(firstText);

  // ---- Second text ----
  gfx->setFont(secondFont);

  int16_t secondX = x + firstWidth + gap;

  int16_t secondBoundsX, secondBoundsY;
  uint16_t secondWidth, secondHeight;

  // Get the suffix bounds using the same baseline first
  gfx->getTextBounds(
    secondText,
    secondX,
    y,
    &secondBoundsX,
    &secondBoundsY,
    &secondWidth,
    &secondHeight);

  int16_t secondY = y;

  if (alignTop) {
    // Align the TOP of both texts
    secondY = y + (firstY - secondBoundsY);
  } else {
    // Align the BOTTOM of both texts
    secondY = y + ((firstY + firstHeight) - (secondBoundsY + secondHeight));
  }

  gfx->setCursor(secondX, secondY);
  gfx->print(secondText);
}

void drawText(
  const String &text, int16_t x, int16_t y, const GFXfont *font) {
  // Set font
  gfx->setFont(font);
  gfx->setTextSize(1);

  // Always black text
  gfx->setTextColor(0x0000);

  // Get the exact bounding box of the text
  int16_t x1, y1;
  uint16_t width, height;

  gfx->getTextBounds(
    text,
    x,
    y,
    &x1,
    &y1,
    &width,
    &height);

  // Clear only the area occupied by the text
  gfx->fillRect(
    x1,
    y1,
    width,
    height,
    0xFFFF);

  // Draw the text
  gfx->setCursor(x, y);
  gfx->print(text);
}


void updateDashboard(float currentSpeed, float currentDist,
                     int currentAqi, int currentWind, int currentUv,
                     float currentHeading, float currentPitch, String currentTime) {

  static float previousDist = -999.0f;

  if (currentDist == previousDist) {
    return;
  }

  previousDist = currentDist;

  char distanceText[16];

  snprintf(distanceText, sizeof(distanceText), "%.1f", currentDist);

  drawTextWithSuffix(
    distanceText,
    "km",
    &Inter_Black_16pt,
    &Inter_Black8pt,
    5,   // X
    50,  // Y / baseline
    10,  // gap
    true);

  drawText(
    currentTime,
    5,
    230,
    &Inter_Black_16pt);

  drawText(
    String(255),
    250,
    60,
    &Inter_Black_16pt);

  drawText(
    String(25),
    270,
    120,
    &Inter_Black_16pt);

  float espTemperature = temperatureRead();
  
  drawTextWithSuffix(
    String((int) espTemperature),
    "o",
    &Inter_Black_16pt,
    &Inter_Black8pt,
    260,  // X
    175,  // Y / baseline
    3,    // gap
    true);

  drawTextWithSuffix(
    String(2334),
    "m",
    &Inter_Black_16pt,
    &Inter_Black8pt,
    210,  // X
    230,  // Y / baseline
    3,    // gap
    false);
}

#endif  // DASHBOARD_H