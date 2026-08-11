/*
 * Tripper Telemetry Dashboard - V5
 * Hardware: Waveshare ESP32-S3-Touch-LCD-2 (ST7789 240x320 / Rotated 320x240)
 * Sensors: QMI8658 IMU (I2C) + NEO-7M GPS (UART)
 *
 * Flow: Splash -> WiFi Provision (if needed) -> Dashboard
 */

#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <WiFi.h>
#include <Arduino_GFX_Library.h>
#include <math.h>

#include "config.h"
#include "sensors.h"
#include "wifi_provision.h"
#include "ui_screens.h"
#include "server_connection.h"
#include "dashboard.h"
#include "nav_display.h"

// ===== Display Setup =====
Arduino_DataBus *bus = new Arduino_ESP32SPI(
  LCD_DC, LCD_CS, LCD_SCLK, LCD_MOSI, LCD_MISO);

Arduino_GFX *gfx = new Arduino_ST7789(
  bus, LCD_RST, 1 /* Landscape: 320x240 */, true /* IPS */,
  240 /* width */, 320 /* height */);

// ===== Global State =====
float pitchIncline = 0.0;
float gpsAltitude = 1060.0;
float gpsHeading = 0.0;
int   gpsSatellites = 8;
bool  gpsFix = true;
bool  hotspotConnected = false;
bool  sosArmed = true;
bool  imuConnected = false;

// Hardware Timers
unsigned long lastIMURead = 0;
unsigned long lastDisplayUpdate = 0;
bool serverConnectionStarted = false;

// GPS Serial
HardwareSerial gpsSerial(1);

// Application state machine
enum AppState {
  STATE_SPLASH,
  STATE_RECONNECTING,
  STATE_PROVISIONING,
  STATE_DASHBOARD
};

AppState appState = STATE_SPLASH;
unsigned long stateStartTime = 0;
unsigned long lastWifiRetry = 0;
bool portalScreenShown = false;
bool splashAPStarted = false;
int lastProgressDrawn = -1;

// ===== Setup =====
void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Wire.begin(I2C_SDA, I2C_SCL, 400000);

  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, HIGH);

  gfx->begin();

  // Show splash screen
  showSplashScreen();
  appState = STATE_SPLASH;
  stateStartTime = millis();
}

// ===== Transition to dashboard =====
void goToDashboard() {
  hotspotConnected = true;
  imuConnected = qmi8658_init();
  initDashboard();
  appState = STATE_DASHBOARD;
  stateStartTime = millis();
}

// ===== Main Loop =====
void loop() {
  unsigned long now = millis();

  switch (appState) {

    // --- SPLASH: Show bike image for 10 seconds with reset window ---
    // During splash, a hidden AP is active. If any device connects → factory reset.
    // This provides a way to reset WiFi credentials without a button.
    case STATE_SPLASH: {
      // Start the AP on first splash frame
      if (!splashAPStarted) {
        WiFi.mode(WIFI_AP);
        WiFi.softAP(AP_SSID, AP_PASS);
        splashAPStarted = true;
        delay(50);
      }

      unsigned long elapsed = now - stateStartTime;

      // Draw progress bar (updates every ~3% to avoid flicker)
      int progress = (elapsed * 100) / 15000;  // 0-100 over 15 seconds
      if (progress > 100) progress = 100;
      if (progress != lastProgressDrawn) {
        int barX = 40;
        int barY = 224;
        int barW = 240;
        int barH = 6;
        int barR = 3;
        int fillW = (barW * progress) / 100;

        // Bar background
        gfx->fillRoundRect(barX, barY, barW, barH, barR, 0x3186);
        // Bar fill (orange accent)
        if (fillW > 0) {
          gfx->fillRoundRect(barX, barY, fillW, barH, barR, COL_ORANGE);
        }
        lastProgressDrawn = progress;
      }

      // Check if any device connected to our AP → RESET
      if (WiFi.softAPgetStationNum() > 0) {
        // Someone connected! Erase everything and restart.
        gfx->fillRect(0, 200, SCREEN_W, 40, 0x0000);
        gfx->setTextSize(2);
        gfx->setTextColor(COL_RED);
        gfx->setCursor(50, 206);
        gfx->print("RESETTING...");

        // Erase stored WiFi credentials
        clearCredentials();

        // Stop AP
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_OFF);

        delay(1500);
        ESP.restart();
        return; // Never reached
      }

      // After 15 seconds, stop AP and proceed normally
      if (elapsed >= 15000) {
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_OFF);
        splashAPStarted = false;
        delay(50);

        if (hasStoredCredentials()) {
          showReconnectingScreen();
          appState = STATE_RECONNECTING;
          stateStartTime = now;
        } else {
          startProvisioningAP();
          showProvisioningScreen();
          appState = STATE_PROVISIONING;
          stateStartTime = now;
          portalScreenShown = false;
        }
      }
      break;
    }

    // --- RECONNECTING: Try stored credentials at boot ---
    case STATE_RECONNECTING:
      if (connectWithStoredCredentials()) {
        goToDashboard();
      } else {
        // Load stored creds into staSSID/staPass for background retry
        loadCredentials(staSSID, staPass);
        // Go to dashboard anyway - will keep retrying in background
        WiFi.mode(WIFI_STA);
        WiFi.begin(staSSID.c_str(), staPass.c_str());
        goToDashboard();
      }
      break;

    // --- PROVISIONING: AP running, serving portal, waiting for creds ---
    case STATE_PROVISIONING: {
      ProvisionState ps = provisioningLoop();

      // Show portal URL once a client connects
      if (ps == PROV_CLIENT_CONNECTED && !portalScreenShown) {
        showPortalReadyScreen();
        portalScreenShown = true;
      }

      // User submitted WiFi credentials via the web form
      if (ps == PROV_CREDS_RECEIVED) {
        // Save credentials immediately and go to dashboard
        saveCredentials(staSSID, staPass);
        // Stop AP and start STA mode
        stopProvisioningAP();
        WiFi.mode(WIFI_STA);
        WiFi.begin(staSSID.c_str(), staPass.c_str());
        // Go straight to dashboard - WiFi connects in background
        goToDashboard();
      }
      break;
    }

    // --- DASHBOARD: Normal telemetry operation ---
    case STATE_DASHBOARD:
      // Process GPS
      while (gpsSerial.available() > 0) {
        parseNMEA(gpsSerial.readStringUntil('\n'));
      }

      // Read IMU at 50Hz
      if (imuConnected && (now - lastIMURead >= 20)) {
        float ax, ay, az;
        qmi8658_read_accel(&ax, &ay, &az);
        float rawPitch = atan2f(ay, sqrtf(ax * ax + az * az)) * RAD2DEG;
        pitchIncline = (pitchIncline * 0.85f) + (rawPitch * 0.15f);
        lastIMURead = now;
      }

      // WiFi: check status, retry in background if disconnected
      hotspotConnected = (WiFi.status() == WL_CONNECTED);
      if (!hotspotConnected && (now - lastWifiRetry >= 5000)) {
        // Silently retry connection in background
        WiFi.disconnect();
        WiFi.begin(staSSID.c_str(), staPass.c_str());
        lastWifiRetry = now;
      }

      // --- Server connection: start after WiFi connects (background, non-blocking) ---
      if (hotspotConnected && !serverConnectionStarted) {
        initServerConnection();
        serverConnectionStarted = true;
      }
      if (serverConnectionStarted) {
        serverConnectionLoop();
        // Update server with GPS data (development: dummy coords)
        updateDeviceGPS(deviceLat, deviceLng, gpsFix);
      }

      // --- Navigation mode handling ---
      if (isNavDisplayActive()) {
        // In navigation mode: render nav screen instead of dashboard
        if (!navDisplayLoop()) {
          // Navigation ended, re-init dashboard display
          initDashboard();
        }
      } else if (getNavState() == NAV_ACTIVE) {
        // Server just started navigation - switch to nav display
        enterNavMode();
      } else {
        // Normal dashboard display at 10Hz
        if (now - lastDisplayUpdate >= 100) {
          updateDashboard();
          lastDisplayUpdate = now;
        }
      }
      break;
  }
}
