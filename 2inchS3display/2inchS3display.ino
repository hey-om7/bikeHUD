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
#include "air_quality.h"
#include "dashboard.h"
#include "nav_display.h"
#include "device_pairing.h"

// ===== Display Setup =====
Arduino_DataBus *bus = new Arduino_ESP32SPI(
  LCD_DC, LCD_CS, LCD_SCLK, LCD_MOSI, LCD_MISO);

Arduino_GFX *gfx = new Arduino_ST7789(
  bus, LCD_RST, 1 /* Landscape: 320x240 */, true /* IPS */,
  240 /* width */, 320 /* height */);

// ===== Global State =====
float pitchIncline = 0.0;
float rollTilt = 0.0;
float gpsAltitude = 1060.0;
float gpsHeading = 0.0;
float gpsLat = 0.0;         // decimal degrees; set by real GPS fix
float gpsLng = 0.0;         // decimal degrees; set by real GPS fix
float gpsSpeed = 0.0;      // ground speed, km/h
int   gpsSatellites = 0;
bool  gpsFix = false;
bool  hotspotConnected = false;
bool  sosArmed = true;
bool  imuConnected = false;

// Hardware Timers
unsigned long lastIMURead = 0;
unsigned long lastDisplayUpdate = 0;
unsigned long lastAqWidgetRefresh = 0;  // 15-min forced refresh for AQ widgets
bool serverConnectionStarted = false;

// GPS Serial
HardwareSerial gpsSerial(1);

// Application state machine
enum AppState {
  STATE_SPLASH,
  STATE_WIFI_SETUP,
  STATE_PAIRING,
  STATE_DASHBOARD
};

AppState appState = STATE_SPLASH;
unsigned long stateStartTime = 0;
bool splashAPStarted = false;
int lastProgressDrawn = -1;
bool pairingScreenShown = false;
bool wifiSetupScreenShown = false;

// ===== Setup =====
void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  Serial.printf("[I2C] Bus on SDA=%d, SCL=%d\n", I2C_SDA, I2C_SCL);

  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, HIGH);

  gfx->begin();

  // Generate unique device ID from MAC address
  generateDeviceId();

  // Show splash screen
  showSplashScreen();

  // GPS boot check: confirm the NEO-7M is wired correctly on pins 13/15 and
  // print any coordinates it already has. Runs while the splash is visible.
  gpsBootDiagnostic(gpsSerial, 2500);

  appState = STATE_SPLASH;
  stateStartTime = millis();
}

// ===== Transition to dashboard =====
void goToDashboard() {
  imuConnected = qmi8658_init();
  lastIMURead = millis();  // Prevent huge dt on first imu_update call
  initDashboard();
  appState = STATE_DASHBOARD;
  stateStartTime = millis();
}

// ===== Main Loop =====
void loop() {
  unsigned long now = millis();

  switch (appState) {

    // --- SPLASH: Show bike image for 3 seconds with reset window ---
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

      // Draw progress bar incrementally (only the new portion each frame)
      int progress = (elapsed * 100) / 3000;  // 0-100 over 3 seconds
      if (progress > 100) progress = 100;
      if (progress != lastProgressDrawn) {
        int barX = 40;
        int barY = 224;
        int barW = 240;
        int barH = 6;
        int barR = 3;

        // Draw background track only once on first frame
        if (lastProgressDrawn < 0) {
          gfx->fillRoundRect(barX, barY, barW, barH, barR, 0x3186);
        }

        // Only draw the new pixels since last update (incremental fill)
        int prevFillW = (lastProgressDrawn > 0) ? (barW * lastProgressDrawn) / 100 : 0;
        int currFillW = (barW * progress) / 100;
        if (currFillW > prevFillW && currFillW > 0) {
          int newX = barX + prevFillW;
          int newW = currFillW - prevFillW;
          // Use full rounded rect only for the first segment, plain rect after
          if (prevFillW == 0) {
            gfx->fillRoundRect(barX, barY, currFillW, barH, barR, 0xFFE0);
          } else {
            gfx->fillRect(newX, barY, newW, barH, 0xFFE0);
            // Redraw right rounded cap for smooth leading edge
            if (currFillW >= barR) {
              gfx->fillRoundRect(barX + currFillW - barR, barY, barR, barH, barR, 0xFFE0);
            }
          }
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

      // After 3 seconds, stop reset-window AP and start concurrent WiFi
      if (elapsed >= 3000) {
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_OFF);
        splashAPStarted = false;
        delay(50);

        // Start AP+STA concurrently: hotspot always available,
        // STA connects in background if credentials exist
        wifiConcurrentStart();

        // Check if device is already paired AND has WiFi creds
        if (isDevicePaired() && hasStoredCredentials()) {
          // Already paired with WiFi — go straight to dashboard
          goToDashboard();
        } else if (!hasStoredCredentials()) {
          // No WiFi credentials — show WiFi setup screen first
          showProvisioningScreen();
          appState = STATE_WIFI_SETUP;
          stateStartTime = millis();
          wifiSetupScreenShown = true;
        } else {
          // Has WiFi but not paired — go to pairing (WiFi will connect in bg)
          showWaitingForPairingScreen();
          appState = STATE_PAIRING;
          stateStartTime = millis();
          pairingScreenShown = false;
        }
      }
      break;
    }

    // --- WIFI_SETUP: Show WiFi provisioning screen, wait for user to enter creds ---
    case STATE_WIFI_SETUP: {
      // Keep WiFi manager running (handles AP portal + STA connection)
      hotspotConnected = wifiManagerLoop();

      // Once WiFi is connected, transition to pairing (or dashboard if already paired)
      if (hotspotConnected) {
        showConnectedScreen();
        delay(1500);

        if (isDevicePaired()) {
          // Already paired — go to dashboard
          goToDashboard();
        } else {
          // WiFi connected, now register with server for pairing
          showWaitingForPairingScreen();
          appState = STATE_PAIRING;
          stateStartTime = millis();
          pairingScreenShown = false;
        }
      }
      break;
    }

    // --- PAIRING: WiFi is connected, register with server, show QR/code, wait for pair ---
    case STATE_PAIRING: {
      // Keep WiFi manager running
      hotspotConnected = wifiManagerLoop();

      // Start server connection once WiFi is up
      if (hotspotConnected && !serverConnectionStarted) {
        initServerConnection();
        serverConnectionStarted = true;
      }

      // Keep WebSocket alive
      if (serverConnectionStarted && hotspotConnected) {
        serverConnectionLoop();
      }

      // Once we receive the pairing code from server, show the pairing screen
      if (isPairingCodeReady() && !pairingScreenShown) {
        showPairingScreen(pairingCode);
        pairingScreenShown = true;
      }

      // Once paired, show success and transition to dashboard
      if (isDevicePairedConfirmed()) {
        showPairedSuccessScreen();
        delay(2000);
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

      // Print live GPS coordinates to the serial monitor (throttled to 5s,
      // and immediately when a fix is first acquired).
      gpsPrintStatus(5000);

      // Read IMU at 50Hz (gyro + accel complementary filter)
      if (imuConnected && (now - lastIMURead >= 20)) {
        float dt = (now - lastIMURead) / 1000.0f;
        imu_update(dt);
        lastIMURead = now;
      }

      // WiFi manager: handles AP portal, STA connection, reconnect, all non-blocking
      hotspotConnected = wifiManagerLoop();

      // --- Server connection: start after WiFi connects (background, non-blocking) ---
      if (hotspotConnected && !serverConnectionStarted) {
        initServerConnection();
        initAirQuality();
        serverConnectionStarted = true;
      }
      if (serverConnectionStarted) {
        // If WiFi dropped, pause server comms (they'll resume when reconnected)
        if (hotspotConnected) {
          serverConnectionLoop();
          airQualityLoop();
          // Feed the REAL parsed GPS fix to the server connection layer so
          // routing + closed-loop frame selection use the live position.
          updateDeviceGPS(gpsLat, gpsLng, gpsFix);
        }
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
        // Normal dashboard display at ~30fps.
        // Widgets self-skip when unchanged, so calling this every tick is cheap
        // and each changed value refreshes only its own region.
        if (now - lastDisplayUpdate >= 33) {

          DashboardData data;

          // --- Live values ---
          // Temperature: read only every 10 seconds to avoid rapid flickering
          static int cachedTemp = (int) temperatureRead();
          static unsigned long lastTempRead = 0;
          if (now - lastTempRead >= 10000) {
            cachedTemp = (int) temperatureRead();
            lastTempRead = now;
          }
          data.temp      = cachedTemp;
          data.timeOnSec = now / 1000;               // stopwatch since boot
          data.heading   = gpsHeading;
          data.pitch     = pitchIncline;
          data.altitude  = gpsAltitude;

          // --- Placeholders (swap for real sources when available) ---
          data.speed = 55.0f;
          data.dist  = 3.5f;

          // --- Air Quality API values (fetched every 10 minutes, integers) ---
          const AirQualityData &aq = getAirQuality();
          if (aq.valid) {
            data.altitude = (float) aq.elevation;  // elevation -> altitude widget
            data.uv       = aq.uvIndex;            // uv_index  -> UV widget
            data.aqi      = aq.usAqi;              // us_aqi    -> AQI widget
          }
          // Until the first fetch succeeds: altitude falls back to gpsAltitude,
          // and UV/AQI render as "--".

          // --- Force redraw of the 3 AQ widgets every 15 minutes ---
          // Keeps the altitude/UV/AQI area fresh even if the numeric value did
          // not change between consecutive fetches.
          if (now - lastAqWidgetRefresh >= 15UL * 60UL * 1000UL) {
            wAlt.drawn = false;
            wUv.drawn  = false;
            wAqi.drawn = false;
            lastAqWidgetRefresh = now;
          }

          updateDashboard(data);
          lastDisplayUpdate = now;
        }
      }
      break;
  }
}
