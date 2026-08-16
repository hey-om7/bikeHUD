/*
 * dashboard.h - Full Dashboard Render and Dynamic Text Update
 */
#ifndef DASHBOARD_H
#define DASHBOARD_H

#include <Arduino_GFX_Library.h>
#include "config.h"
#include "dashboard_bg.h" // Contains your new full-screen bitmap: dashboard_bg_bitmap
#include "sensors.h"     
#include "Inter_Black_16pt.h"
#include "Inter_Black12pt.h"

extern Arduino_GFX *gfx;
extern bool hotspotConnected;
extern bool sosArmed;

// ===== Dummy Variables for State Tracking =====
// Tracking previous values prevents flickering by only redrawing when necessary
static float prevPitch = -999.0;
static float prevAlt   = -999.0;
static float prevHead  = -999.0;
static float prevSpeed = -1.0;
static float prevDist  = -1.0;
static int   prevTemp  = -999;
static int   prevAqi   = -1;
static int   prevWind  = -1;
static int   prevUv    = -1;

// Define your text background color (matches the off-white of the UI cards)
// Adjust this hex if the card background isn't pure white (e.g., 0xF7BE)
#define CARD_BG_COLOR 0xFFFF 
#define TEXT_COLOR    0x0000 // Black text

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
  gfx->setTextSize(2); // Adjust text size based on your font
  gfx->setTextColor(TEXT_COLOR, CARD_BG_COLOR); // Using BG color prevents ghosting
}

void updateDashboard(float currentSpeed, float currentDist, int currentTemp, 
                     int currentAqi, int currentWind, int currentUv, 
                     float currentHeading, float currentPitch, String currentTime) {

  static float previousDist = -999.0f;

  if (currentDist == previousDist) {
    return;
  }

  previousDist = currentDist;

  // Clear the complete widget

  // gfx->fillRect(10, 5, 100, 30, 0xFFFF);

  // ---- Distance value ----

  gfx->setFont(&Inter_Black_16pt);

  gfx->setTextSize(1);

  gfx->setTextColor(0x0000);

  gfx->setCursor(10, 50);

  gfx->print(currentDist, 1);

  // ---- "km" ----

  gfx->setFont(&Inter_Black_12pt);

  gfx->setTextSize(1);

  // Position this depending on how your 18pt font looks

  gfx->setCursor(60, 50);

  gfx->print("km");

}

#endif // DASHBOARD_H