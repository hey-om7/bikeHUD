/*
 * device_pairing.h - Device registration, QR/code display, and pairing flow
 * Tripper Telemetry Dashboard V5
 *
 * Flow:
 *   1. ESP32 boots and generates a unique device ID from its MAC address.
 *   2. On first boot (or after unpair), after WiFi connects, it sends
 *      DEVICE_REGISTER to the server via WebSocket.
 *   3. Server responds with PAIRING_CODE — ESP displays the 8-digit code and a
 *      QR code on screen for the user to scan/enter in the app.
 *   4. When the user pairs via the app, the server sends DEVICE_PAIRED — ESP
 *      saves the paired state to NVS and proceeds to the dashboard.
 *   5. On subsequent boots, if already paired, skip straight to dashboard.
 */
#ifndef DEVICE_PAIRING_H
#define DEVICE_PAIRING_H

#include <WiFi.h>
#include <Preferences.h>
#include <Arduino_GFX_Library.h>
#include "config.h"
#include "qrcode.h"

extern Arduino_GFX *gfx;

// ===== QR Code Generation (minimal implementation for ESP32) =====
// Uses the "QRCode" library by Richard Moore (ricmoo/qrcode).
// Renamed to avoid conflict with ESP-IDF's own qrcode.h in the SDK include path.
#include "qrcode_ricmoo.h"

// ===== Device Identity =====
static char deviceUniqueId[20] = {0};  // e.g. "TRIP-AABBCCDD"

// Generate a unique device ID from the ESP32's WiFi MAC address.
// Format: TRIP-XXXXXXXX (8 hex chars from the lower 4 bytes of MAC)
void generateDeviceId() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(deviceUniqueId, sizeof(deviceUniqueId), "TRIP-%02X%02X%02X%02X",
           mac[2], mac[3], mac[4], mac[5]);
  Serial.printf("[PAIR] Device ID: %s\n", deviceUniqueId);
}

// Get the generated device ID
const char* getDeviceId() {
  return deviceUniqueId;
}

// ===== NVS Pairing State =====
static Preferences pairingPrefs;

bool isDevicePaired() {
  pairingPrefs.begin("tripper-pair", true);
  bool paired = pairingPrefs.getBool("paired", false);
  pairingPrefs.end();
  return paired;
}

void saveDevicePaired(bool paired) {
  pairingPrefs.begin("tripper-pair", false);
  pairingPrefs.putBool("paired", paired);
  pairingPrefs.end();
}

void clearPairingState() {
  pairingPrefs.begin("tripper-pair", false);
  pairingPrefs.clear();
  pairingPrefs.end();
}

// ===== Pairing Screen State =====
static char pairingCode[12] = {0};     // 8-digit code from server
static bool pairingCodeReceived = false;
static bool devicePairedConfirmed = false;

// Reset pairing state (called when entering pairing mode)
void resetPairingState() {
  pairingCode[0] = '\0';
  pairingCodeReceived = false;
  devicePairedConfirmed = false;
}

// Called from server_connection.h when PAIRING_CODE message arrives
void onPairingCodeReceived(const char* code) {
  strlcpy(pairingCode, code, sizeof(pairingCode));
  pairingCodeReceived = true;
  Serial.printf("[PAIR] Received pairing code: %s\n", pairingCode);
}

// Called from server_connection.h when DEVICE_PAIRED message arrives
void onDevicePaired() {
  devicePairedConfirmed = true;
  saveDevicePaired(true);
  Serial.println("[PAIR] Device paired successfully!");
}

bool isPairingCodeReady() { return pairingCodeReceived; }
bool isDevicePairedConfirmed() { return devicePairedConfirmed; }

// ===== Draw QR Code on Screen =====
// Renders a QR code encoding "tripper://pair/<code>" centered on the display.
// Positioned in the upper-mid section (y: 32 to ~152)
void drawQRCode(const char* code) {
  // Build the pairing URI: tripper://pair/12345678
  char uri[40];
  snprintf(uri, sizeof(uri), "tripper://pair/%s", code);

  // Create QR code (version 3 = 29x29 modules, ECC_LOW for max data)
  QRCode qrcode;
  uint8_t qrcodeData[qrcode_getBufferSize(3)];
  qrcode_initText(&qrcode, qrcodeData, 3, ECC_LOW, uri);

  // Calculate sizing to fit between y=32 and y=152 (120px available height)
  // With padding, target ~108px max → 3px per module for 29 modules = 87px
  int moduleSize = 3;
  int qrPixelSize = qrcode.size * moduleSize;  // 29*3 = 87px

  // Center horizontally and vertically in the QR zone (y: 32..152)
  int qrZoneTop = 32;
  int qrZoneHeight = 120;
  int qrX = (SCREEN_W - qrPixelSize) / 2;
  int qrY = qrZoneTop + (qrZoneHeight - qrPixelSize) / 2;

  // White background behind QR with padding
  int padding = 6;
  gfx->fillRoundRect(qrX - padding, qrY - padding,
                     qrPixelSize + padding * 2, qrPixelSize + padding * 2,
                     4, COL_WHITE);

  // Draw QR modules
  for (uint8_t y = 0; y < qrcode.size; y++) {
    for (uint8_t x = 0; x < qrcode.size; x++) {
      if (qrcode_getModule(&qrcode, x, y)) {
        gfx->fillRect(qrX + x * moduleSize, qrY + y * moduleSize,
                      moduleSize, moduleSize, COL_BLACK);
      }
    }
  }
}

// ===== Show Pairing Screen =====
// Displays the QR code + 8-digit code + instructions
// Layout: 320x240 screen, centered and balanced
void showPairingScreen(const char* code) {
  gfx->fillScreen(0x10A3);

  // --- Top bar: brand + subtitle ---
  gfx->setTextSize(1);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor(132, 4);
  gfx->print("TRIPPER");
  gfx->setTextColor(0x8C71);
  gfx->setCursor(112, 16);
  gfx->print("Device Pairing");

  // Thin divider
  gfx->drawFastHLine(40, 28, SCREEN_W - 80, 0x3186);

  // --- QR Code (centered in upper-mid section) ---
  drawQRCode(code);

  // --- Divider between QR and code ---
  int divY = 158;
  gfx->drawFastHLine(40, divY, SCREEN_W - 80, 0x3186);

  // --- "Or enter code" label (centered) ---
  gfx->setTextSize(1);
  gfx->setTextColor(0xB596);
  const char* label = "Or enter this code in the app:";
  int labelW = strlen(label) * 6;
  gfx->setCursor((SCREEN_W - labelW) / 2, divY + 8);
  gfx->print(label);

  // --- Large 8-digit code (centered, bold orange) ---
  // Size 3: each char = 18px wide, 24px tall
  gfx->setTextSize(3);
  gfx->setTextColor(COL_ORANGE);
  int codeW = 8 * 18;
  gfx->setCursor((SCREEN_W - codeW) / 2, divY + 24);
  gfx->print(code);

  // --- Bottom instruction (centered, two lines) ---
  gfx->setTextSize(1);
  gfx->setTextColor(0x8C71);
  const char* line1 = "Scan QR or enter code in the Tripper app";
  const char* line2 = "to pair this device to your account.";
  int l1W = strlen(line1) * 6;
  int l2W = strlen(line2) * 6;
  gfx->setCursor((SCREEN_W - l1W) / 2, 216);
  gfx->print(line1);
  gfx->setCursor((SCREEN_W - l2W) / 2, 228);
  gfx->print(line2);
}

// ===== Show "Waiting for Server" Screen =====
// Shown while connecting to server to get pairing code
// Clean centered layout with visual feedback
void showWaitingForPairingScreen() {
  gfx->fillScreen(0x10A3);

  // --- Brand (centered, top) ---
  gfx->setTextSize(2);
  gfx->setTextColor(COL_ORANGE);
  // "TRIPPER" = 7 chars × 12px = 84px wide
  gfx->setCursor((SCREEN_W - 84) / 2, 40);
  gfx->print("TRIPPER");

  // --- Connecting icon: three concentric arcs (WiFi-like) ---
  int cx = SCREEN_W / 2;
  int cy = 90;
  gfx->drawCircle(cx, cy, 18, COL_BLUE);
  gfx->drawCircle(cx, cy, 12, COL_BLUE);
  gfx->drawCircle(cx, cy, 6, COL_BLUE);
  gfx->fillCircle(cx, cy, 3, COL_WHITE);

  // --- Status text (centered) ---
  gfx->setTextSize(1);
  gfx->setTextColor(COL_BLUE);
  const char* status = "Connecting to server...";
  int statusW = strlen(status) * 6;
  gfx->setCursor((SCREEN_W - statusW) / 2, 120);
  gfx->print(status);

  // --- Loading bar background ---
  int barX = 80;
  int barY = 140;
  int barW = SCREEN_W - 160;
  int barH = 4;
  gfx->fillRoundRect(barX, barY, barW, barH, 2, 0x2945);
  // Animated portion (static snapshot — shows progress)
  gfx->fillRoundRect(barX, barY, barW / 3, barH, 2, COL_BLUE);

  // --- Hint (centered) ---
  gfx->setTextColor(0x8C71);
  const char* hint1 = "Please wait while the device";
  const char* hint2 = "registers with the server.";
  int h1W = strlen(hint1) * 6;
  int h2W = strlen(hint2) * 6;
  gfx->setCursor((SCREEN_W - h1W) / 2, 164);
  gfx->print(hint1);
  gfx->setCursor((SCREEN_W - h2W) / 2, 177);
  gfx->print(hint2);

  // --- Bottom note ---
  gfx->drawFastHLine(60, 204, SCREEN_W - 120, 0x3186);
  gfx->setTextColor(0x8C71);
  const char* note = "Ensure WiFi is connected";
  int noteW = strlen(note) * 6;
  gfx->setCursor((SCREEN_W - noteW) / 2, 214);
  gfx->print(note);
}

// ===== Show "Paired Successfully" Screen =====
// Clean centered success screen with next-step guidance
void showPairedSuccessScreen() {
  gfx->fillScreen(0x10A3);

  // --- Brand ---
  gfx->setTextSize(2);
  gfx->setTextColor(COL_ORANGE);
  gfx->setCursor((SCREEN_W - 84) / 2, 24);
  gfx->print("TRIPPER");

  // --- Large checkmark (centered) ---
  int cx = SCREEN_W / 2;
  int cy = 72;
  // Thick checkmark drawn with 3 parallel lines
  for (int i = 0; i < 4; i++) {
    gfx->drawLine(cx - 16, cy + i, cx - 4, cy + 12 + i, COL_GREEN);
    gfx->drawLine(cx - 4, cy + 12 + i, cx + 16, cy - 4 + i, COL_GREEN);
  }

  // --- Success badge (centered pill) ---
  int badgeW = 180;
  int badgeH = 30;
  int badgeX = (SCREEN_W - badgeW) / 2;
  int badgeY = 98;
  gfx->fillRoundRect(badgeX, badgeY, badgeW, badgeH, 10, COL_GREEN_DIM);
  gfx->setTextSize(2);
  gfx->setTextColor(COL_GREEN);
  // "PAIRED!" = 7 chars × 12px = 84px
  gfx->setCursor((SCREEN_W - 84) / 2, badgeY + 7);
  gfx->print("PAIRED!");

  // --- Info text (centered, multi-line) ---
  gfx->setTextSize(1);
  gfx->setTextColor(COL_WHITE);
  const char* l1 = "Device paired to your account.";
  int l1W = strlen(l1) * 6;
  gfx->setCursor((SCREEN_W - l1W) / 2, 142);
  gfx->print(l1);

  gfx->setTextColor(0xB596);
  const char* l2 = "Starting dashboard shortly...";
  int l2W = strlen(l2) * 6;
  gfx->setCursor((SCREEN_W - l2W) / 2, 162);
  gfx->print(l2);

  // --- Bottom divider + progress hint ---
  gfx->drawFastHLine(60, 196, SCREEN_W - 120, 0x3186);
  gfx->setTextSize(1);
  gfx->setTextColor(COL_BLUE);
  const char* prog = "Preparing dashboard...";
  int progW = strlen(prog) * 6;
  gfx->setCursor((SCREEN_W - progW) / 2, 210);
  gfx->print(prog);
}

// ===== Send DEVICE_REGISTER Message =====
// Should be called after WebSocket connects if device is not yet paired.
// The server_connection module handles the actual WebSocket send.
// This function builds the JSON message content.
void buildRegisterMessage(char* buffer, size_t bufSize) {
  snprintf(buffer, bufSize,
    "{\"type\":\"DEVICE_REGISTER\",\"deviceId\":\"%s\",\"firmwareVer\":\"5.0.0\"}",
    deviceUniqueId);
}

#endif // DEVICE_PAIRING_H
