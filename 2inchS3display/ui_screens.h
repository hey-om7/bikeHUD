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
// Shows AP SSID/Password and clear step-by-step instructions
void showProvisioningScreen() {
  // Dark background
  gfx->fillScreen(0x10A3);  // dark blue-gray

  // Title
  gfx->setTextSize(2);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(70, 8);
  gfx->print("TRIPPER");

  // Subtitle
  gfx->setTextSize(1);
  gfx->setTextColor(COL_WHITE);
  gfx->setCursor(90, 30);
  gfx->print("WiFi Setup");

  // Divider
  gfx->drawFastHLine(20, 44, SCREEN_W - 40, 0x3186);

  // Step 1
  gfx->setTextSize(1);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(16, 52);
  gfx->print("STEP 1:");
  gfx->setTextColor(0xB596);
  gfx->setCursor(68, 52);
  gfx->print("Connect phone to this WiFi");

  // SSID box
  gfx->fillRoundRect(16, 66, SCREEN_W - 32, 28, 6, 0x2945);
  gfx->drawRoundRect(16, 66, SCREEN_W - 32, 28, 6, COL_ORANGE);
  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);
  gfx->setCursor(24, 70);
  gfx->print("Network:");
  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  // Center SSID
  int ssidLen = strlen(AP_SSID);
  int ssidPixW = ssidLen * 12;
  gfx->setCursor(max(24, (int)(SCREEN_W - ssidPixW) / 2 + 30), 72);
  gfx->print(AP_SSID);

  // Password box
  gfx->fillRoundRect(16, 100, SCREEN_W - 32, 28, 6, 0x2945);
  gfx->drawRoundRect(16, 100, SCREEN_W - 32, 28, 6, 0x3186);
  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);
  gfx->setCursor(24, 104);
  gfx->print("Password:");
  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  int passLen = strlen(AP_PASS);
  int passPixW = passLen * 12;
  gfx->setCursor(max(24, (int)(SCREEN_W - passPixW) / 2 + 30), 106);
  gfx->print(AP_PASS);

  // Step 2
  gfx->setTextSize(1);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(16, 140);
  gfx->print("STEP 2:");
  gfx->setTextColor(0xB596);
  gfx->setCursor(68, 140);
  gfx->print("Open browser, go to:");

  // URL box
  gfx->fillRoundRect(16, 154, SCREEN_W - 32, 26, 6, 0x2945);
  gfx->drawRoundRect(16, 154, SCREEN_W - 32, 26, 6, COL_BLUE);
  gfx->setTextSize(2);
  gfx->setTextColor(COL_BLUE);
  gfx->setCursor(52, 158);
  gfx->print("192.168.4.1");

  // Step 3
  gfx->setTextSize(1);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(16, 190);
  gfx->print("STEP 3:");
  gfx->setTextColor(0xB596);
  gfx->setCursor(68, 190);
  gfx->print("Enter your mobile hotspot");
  gfx->setCursor(68, 202);
  gfx->print("name & password to save.");

  // Bottom status
  gfx->drawFastHLine(20, 218, SCREEN_W - 40, 0x3186);
  gfx->setTextColor(COL_BLUE);
  gfx->setCursor(100, 226);
  gfx->print("Waiting...");
}

// ===== Client Connected Screen =====
// Phone connected to the AP — show clear instruction to open browser
void showPortalReadyScreen() {
  // Clear lower half
  gfx->fillRect(0, 134, SCREEN_W, SCREEN_H - 134, 0x10A3);

  // Connected badge
  gfx->fillRoundRect(60, 140, 200, 24, 8, COL_GREEN_DIM);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_GREEN);
  gfx->setCursor(82, 146);
  gfx->print("PHONE CONNECTED!");

  // Instruction
  gfx->setTextColor(0xB596);
  gfx->setCursor(30, 174);
  gfx->print("Now open your browser and visit:");

  // URL box
  gfx->fillRoundRect(30, 188, SCREEN_W - 60, 28, 6, 0x2945);
  gfx->drawRoundRect(30, 188, SCREEN_W - 60, 28, 6, COL_BLUE);
  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  gfx->setCursor(46, 194);
  gfx->print("192.168.4.1");

  // Sub-text
  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);
  gfx->setCursor(24, 224);
  gfx->print("Enter your hotspot SSID & password");
}

// ===== Connecting Screen =====
// Shows while ESP is attempting to connect to the user's hotspot
void showConnectingScreen(const char* ssid) {
  gfx->fillScreen(0x10A3);

  // Title
  gfx->setTextSize(2);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(70, 30);
  gfx->print("TRIPPER");

  // WiFi icon (animated feel with concentric arcs)
  int cx = SCREEN_W / 2;
  gfx->drawCircle(cx, 80, 16, COL_BLUE);
  gfx->drawCircle(cx, 80, 10, COL_BLUE);
  gfx->fillCircle(cx, 80, 4, COL_WHITE);

  // Status
  gfx->setTextSize(1);
  gfx->setTextColor(COL_BLUE);
  gfx->setCursor(82, 108);
  gfx->print("Connecting to:");

  // SSID
  gfx->setTextSize(2);
  gfx->setTextColor(COL_WHITE);
  int len = strlen(ssid);
  int pixW = len * 12;
  int startX = max(16, (SCREEN_W - pixW) / 2);
  gfx->setCursor(startX, 126);
  gfx->print(ssid);

  // Progress hint
  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);
  gfx->setCursor(90, 160);
  gfx->print("Please wait...");

  // Bottom hint
  gfx->setTextColor(0x8C71);
  gfx->setCursor(30, 210);
  gfx->print("Make sure your mobile hotspot is");
  gfx->setCursor(30, 222);
  gfx->print("turned on and within range.");
}

// ===== Connection Success Screen =====
void showConnectedScreen() {
  gfx->fillScreen(0x10A3);

  // Title
  gfx->setTextSize(2);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(70, 40);
  gfx->print("TRIPPER");

  // Checkmark
  int cx = SCREEN_W / 2;
  gfx->drawLine(cx - 16, 95, cx - 5, 107, COL_GREEN);
  gfx->drawLine(cx - 15, 95, cx - 4, 107, COL_GREEN);
  gfx->drawLine(cx - 14, 95, cx - 3, 107, COL_GREEN);
  gfx->drawLine(cx - 5, 107, cx + 18, 85, COL_GREEN);
  gfx->drawLine(cx - 4, 107, cx + 19, 85, COL_GREEN);
  gfx->drawLine(cx - 3, 107, cx + 20, 85, COL_GREEN);

  // WiFi Connected badge
  gfx->fillRoundRect(60, 118, 200, 28, 8, COL_GREEN_DIM);
  gfx->setTextSize(2);
  gfx->setTextColor(COL_GREEN);
  gfx->setCursor(74, 124);
  gfx->print("CONNECTED!");

  // IP Address
  gfx->setTextSize(1);
  gfx->setTextColor(0xB596);
  gfx->setCursor(80, 160);
  gfx->print("WiFi connected. IP:");
  gfx->setTextColor(COL_WHITE);
  gfx->setCursor(72, 176);
  gfx->print(WiFi.localIP().toString().c_str());

  // Starting dashboard hint
  gfx->setTextColor(0x8C71);
  gfx->setCursor(60, 210);
  gfx->print("Starting dashboard...");
}

// ===== Stored WiFi Connecting Screen =====
// Shown on boot when reconnecting to a previously saved network
// Layout (320x240): brand header -> glowing WiFi emblem -> title + saved
// network pill -> progress dots -> footer hint with the reset/re-setup path.
// Pass the saved SSID to show which network is being sought (optional).

// Print text horizontally centred on the screen (default font: 6px/char * size)
static void printCentered(const char* text, int y, uint8_t size, uint16_t color) {
  gfx->setTextSize(size);
  gfx->setTextColor(color);
  int w = strlen(text) * 6 * size;
  gfx->setCursor((SCREEN_W - w) / 2, y);
  gfx->print(text);
}

void showReconnectingScreen(const char* ssid = nullptr) {
  const uint16_t BG        = 0x10A3;  // app-wide dark slate
  const uint16_t GLOW_OUT  = 0x1904;  // faint halo rings behind the emblem
  const uint16_t GLOW_IN   = 0x2166;
  const uint16_t CARD      = 0x2945;
  const uint16_t DIVIDER   = 0x3186;
  const uint16_t MUTED     = 0x8C71;
  const uint16_t SOFT      = 0xB596;

  gfx->fillScreen(BG);

  // --- Header: brand + subtitle (matches pairing screen) ---
  printCentered("TRIPPER", 6, 1, COL_ORANGE);
  printCentered("Network Recovery", 18, 1, MUTED);
  gfx->drawFastHLine(40, 30, SCREEN_W - 80, DIVIDER);

  // --- Emblem: layered halo + proper WiFi fan ---
  int cx = SCREEN_W / 2;
  int cy = 96;  // centre of the fan's pivot area
  gfx->fillCircle(cx, cy - 8, 50, GLOW_OUT);
  gfx->fillCircle(cx, cy - 8, 40, GLOW_IN);

  // Arcs open upward (Arduino_GFX angles: 0 = 3 o'clock, clockwise; 270 = up).
  // Inner two are lit, outer one dimmed to suggest a signal being searched for.
  gfx->fillArc(cx, cy + 4, 34, 29, 225, 315, COL_BLUE_DIM);
  gfx->fillArc(cx, cy + 4, 24, 19, 225, 315, COL_BLUE);
  gfx->fillArc(cx, cy + 4, 14,  9, 225, 315, COL_BLUE);
  gfx->fillCircle(cx, cy + 4, 4, COL_WHITE);

  // --- Title ---
  printCentered("Reconnecting", 150, 2, COL_WHITE);

  // --- Saved network pill ---
  if (ssid && ssid[0]) {
    char label[34];
    snprintf(label, sizeof(label), "%.24s", ssid);  // keep pill within width
    int textW = strlen(label) * 6;
    int pillW = textW + 28;
    int pillX = (SCREEN_W - pillW) / 2;
    int pillY = 172;
    gfx->fillRoundRect(pillX, pillY, pillW, 16, 8, CARD);
    gfx->fillCircle(pillX + 9, pillY + 8, 3, COL_ORANGE);  // status dot
    gfx->setTextSize(1);
    gfx->setTextColor(SOFT);
    gfx->setCursor(pillX + 18, pillY + 4);
    gfx->print(label);
  } else {
    printCentered("Searching for your saved network", 176, 1, SOFT);
  }

  // --- Progress dots (static: centre highlighted) ---
  int dotY = 200;
  gfx->fillCircle(cx - 14, dotY, 3, DIVIDER);
  gfx->fillCircle(cx,      dotY, 4, COL_ORANGE);
  gfx->fillCircle(cx + 14, dotY, 3, DIVIDER);

  // --- Footer: what to do if the network is gone ---
  gfx->drawFastHLine(40, 212, SCREEN_W - 80, DIVIDER);
  printCentered("Turn on your hotspot, or join", 218, 1, MUTED);
  char hint[48];
  snprintf(hint, sizeof(hint), "\"%s\" to set up new WiFi", AP_SSID);
  printCentered(hint, 229, 1, MUTED);
}

#endif // UI_SCREENS_H
