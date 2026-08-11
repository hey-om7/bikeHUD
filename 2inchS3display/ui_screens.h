/*
 * ui_screens.h - Splash, WiFi provisioning screens, connecting screen
 * Tripper Telemetry Dashboard V5
 */
#ifndef UI_SCREENS_H
#define UI_SCREENS_H

#include <Arduino_GFX_Library.h>
#include "config.h"
#include "splash_image.h"

extern Arduino_GFX *gfx;

// ===== Splash Screen =====
void showSplashScreen() {
  gfx->draw16bitRGBBitmap(0, 0, splash_image, SPLASH_WIDTH, SPLASH_HEIGHT);
}

// ===== WiFi Provisioning Screen =====
// Shows AP SSID/Password and instructions to connect
void showProvisioningScreen() {
  // Dark blue/gray gradient background
  gfx->fillRect(0, 0, SCREEN_W, SCREEN_H / 2, 0x1926);  // ~#18242C
  gfx->fillRect(0, SCREEN_H / 2, SCREEN_W, SCREEN_H / 2, 0x10A3);  // ~#101820

  // Title area
  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  gfx->setCursor(70, 16);
  gfx->print("TRIPPER");

  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);  // muted
  gfx->setCursor(76, 38);
  gfx->print("WiFi Setup");

  // Divider
  gfx->drawFastHLine(20, 54, SCREEN_W - 40, 0x3186);

  // WiFi icon area (simple drawn icon)
  int iconX = SCREEN_W / 2;
  int iconY = 78;
  gfx->drawCircle(iconX, iconY, 18, COL_BLUE);
  gfx->drawCircle(iconX, iconY, 12, COL_BLUE);
  gfx->drawCircle(iconX, iconY, 6, COL_BLUE);
  gfx->fillCircle(iconX, iconY, 2, COL_WHITE);

  // Instructions
  gfx->setTextSize(1);
  gfx->setTextColor(0xB596);  // light gray
  gfx->setCursor(42, 106);
  gfx->print("Connect to this WiFi network:");

  // SSID Box
  gfx->fillRoundRect(30, 120, SCREEN_W - 60, 28, 6, 0x2945);  // dark panel
  gfx->drawRoundRect(30, 120, SCREEN_W - 60, 28, 6, COL_ORANGE);
  gfx->setTextSize(2);
  gfx->setTextColor(COL_ORANGE);
  // Center SSID text
  int ssidLen = strlen(AP_SSID);
  int ssidPixW = ssidLen * 12;
  gfx->setCursor((SCREEN_W - ssidPixW) / 2, 126);
  gfx->print(AP_SSID);

  // Password label
  gfx->setTextSize(1);
  gfx->setTextColor(0xB596);
  gfx->setCursor(60, 158);
  gfx->print("Password:");

  // Password value
  gfx->setTextColor(COL_WHITE);
  gfx->setTextSize(2);
  int passLen = strlen(AP_PASS);
  int passPixW = passLen * 12;
  gfx->setCursor((SCREEN_W - passPixW) / 2, 172);
  gfx->print(AP_PASS);

  // Bottom instruction
  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);
  gfx->setCursor(30, 205);
  gfx->print("Then open browser to configure");
  gfx->setCursor(30, 218);
  gfx->print("your mobile hotspot details.");

  // Waiting animation dot area (will be updated)
  gfx->setTextColor(COL_BLUE);
  gfx->setCursor(140, 232);
  gfx->print("Waiting...");
}

// ===== Client Connected Screen =====
// Shows the URL to visit for configuration
void showPortalReadyScreen() {
  // Clear lower area
  gfx->fillRect(0, 100, SCREEN_W, 140, 0x10A3);

  // Divider
  gfx->drawFastHLine(20, 106, SCREEN_W - 40, 0x3186);

  // Connected badge
  gfx->fillRoundRect(80, 112, 160, 22, 6, COL_GREEN_DIM);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_GREEN);
  gfx->setCursor(104, 118);
  gfx->print("DEVICE CONNECTED");

  // URL instruction
  gfx->setTextColor(0xB596);
  gfx->setCursor(44, 146);
  gfx->print("Open your browser and visit:");

  // URL Box
  gfx->fillRoundRect(40, 162, SCREEN_W - 80, 30, 6, 0x2945);
  gfx->drawRoundRect(40, 162, SCREEN_W - 80, 30, 6, COL_BLUE);
  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  gfx->setCursor(52, 168);
  gfx->print("192.168.4.1");

  // Bottom hint
  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);
  gfx->setCursor(26, 204);
  gfx->print("Enter your mobile hotspot details");
  gfx->setCursor(26, 216);
  gfx->print("on the configuration page.");
}

// ===== Connecting Screen =====
void showConnectingScreen(const char* ssid) {
  gfx->fillRect(0, 100, SCREEN_W, 140, 0x10A3);
  gfx->drawFastHLine(20, 106, SCREEN_W - 40, 0x3186);

  gfx->setTextSize(1);
  gfx->setTextColor(COL_BLUE);
  gfx->setCursor(90, 130);
  gfx->print("Connecting to:");

  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  int len = strlen(ssid);
  int pixW = len * 12;
  int startX = max(20, (SCREEN_W - pixW) / 2);
  gfx->setCursor(startX, 150);
  gfx->print(ssid);

  // Loading dots area
  gfx->setTextSize(1);
  gfx->setTextColor(COL_BLUE);
  gfx->setCursor(130, 185);
  gfx->print("Please wait...");
}

// ===== Connection Success Screen =====
void showConnectedScreen() {
  gfx->fillRect(0, 100, SCREEN_W, 140, 0x10A3);
  gfx->drawFastHLine(20, 106, SCREEN_W - 40, 0x3186);

  gfx->fillRoundRect(80, 130, 160, 28, 8, COL_GREEN_DIM);
  gfx->setTextSize(2);
  gfx->setTextColor(COL_GREEN);
  gfx->setCursor(98, 136);
  gfx->print("CONNECTED");

  gfx->setTextSize(1);
  gfx->setTextColor(0xB596);
  gfx->setCursor(68, 175);
  gfx->print("Starting dashboard...");
}

// ===== Stored WiFi Connecting Screen =====
void showReconnectingScreen() {
  gfx->fillRect(0, 0, SCREEN_W, SCREEN_H / 2, 0x1926);
  gfx->fillRect(0, SCREEN_H / 2, SCREEN_W, SCREEN_H / 2, 0x10A3);

  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  gfx->setCursor(70, 60);
  gfx->print("TRIPPER");

  gfx->setTextSize(1);
  gfx->setTextColor(COL_BLUE);
  gfx->setCursor(82, 120);
  gfx->print("Reconnecting WiFi...");

  // Spinner dots
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(100, 150);
  gfx->print("Please wait");
}

#endif // UI_SCREENS_H
