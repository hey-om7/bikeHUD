/*
 * wifi_provision.h - WiFi AP+STA concurrent mode, DNS captive portal, HTTP server
 * Tripper Telemetry Dashboard V5
 *
 * Strategy:
 *   - After splash, always start AP+STA simultaneously.
 *   - If stored credentials exist, begin STA connection in background.
 *   - When STA connects, shut down AP (hotspot) and portal.
 *   - If STA disconnects later (during dashboard), restart AP for re-provisioning.
 *   - If new credentials arrive via portal, save them and attempt STA connection.
 */
#ifndef WIFI_PROVISION_H
#define WIFI_PROVISION_H

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include "config.h"
#include "web_portal.h"

// Provisioning state
enum ProvisionState {
  PROV_IDLE,
  PROV_AP_STARTED,
  PROV_CLIENT_CONNECTED,
  PROV_CREDS_RECEIVED,
  PROV_CONNECTING,
  PROV_SUCCESS,
  PROV_FAILED
};

static WebServer  server(80);
static DNSServer  dnsServer;
static Preferences prefs;
static ProvisionState provState = PROV_IDLE;
static String staSSID = "";
static String staPass = "";
static unsigned long connectStartTime = 0;

// Track whether AP portal is currently active
static bool apPortalActive = false;
// Track whether STA connection attempt is in progress
static bool staConnecting = false;
// Retry interval for STA reconnection
static unsigned long lastStaRetry = 0;
static const unsigned long STA_RETRY_INTERVAL = 5000;  // 5 seconds

// ===== NVS Credential Management =====

bool hasStoredCredentials() {
  prefs.begin("tripper", true);
  String ssid = prefs.getString("ssid", "");
  prefs.end();
  return ssid.length() > 0;
}

bool loadCredentials(String &ssid, String &pass) {
  prefs.begin("tripper", true);
  ssid = prefs.getString("ssid", "");
  pass = prefs.getString("pass", "");
  prefs.end();
  return ssid.length() > 0;
}

void saveCredentials(const String &ssid, const String &pass) {
  prefs.begin("tripper", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
}

void clearCredentials() {
  prefs.begin("tripper", false);
  prefs.clear();
  prefs.end();
}

// ===== HTTP Handlers =====

void handleRoot() {
  server.send(200, "text/html", PORTAL_HTML);
}

void handleConnect() {
  if (server.hasArg("ssid") && server.hasArg("pass")) {
    staSSID = server.arg("ssid");
    staPass = server.arg("pass");
    server.send(200, "application/json", "{\"success\":true}");
    provState = PROV_CREDS_RECEIVED;
  } else {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing fields\"}");
  }
}

void handleNotFound() {
  server.sendHeader("Location", String("http://") + AP_PORTAL_IP, true);
  server.send(302, "text/plain", "");
}

// ===== AP Portal Control =====

// Start AP and captive portal (keeps STA running if already active)
void startProvisioningAP() {
  if (apPortalActive) return;  // Already running

  // Use AP_STA so STA stays connected/connecting in background
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS);
  delay(100);

  dnsServer.start(53, "*", WiFi.softAPIP());

  server.on("/", handleRoot);
  server.on("/connect", HTTP_POST, handleConnect);
  server.on("/generate_204", handleRoot);
  server.on("/fwlink", handleRoot);
  server.onNotFound(handleNotFound);
  server.begin();

  apPortalActive = true;
  provState = PROV_AP_STARTED;
  Serial.println("[WiFi] AP portal started (AP_STA mode)");
}

// Stop AP and portal services, switch to STA-only
void stopProvisioningAP() {
  if (!apPortalActive) return;

  dnsServer.stop();
  server.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);

  apPortalActive = false;
  Serial.println("[WiFi] AP portal stopped, STA-only mode");
}

// ===== Concurrent WiFi Management =====

// Initialize WiFi after splash: start AP + begin STA if creds exist
void wifiConcurrentStart() {
  // Always start AP portal first
  startProvisioningAP();

  // If we have stored credentials, kick off STA connection in background
  if (loadCredentials(staSSID, staPass)) {
    WiFi.begin(staSSID.c_str(), staPass.c_str());
    staConnecting = true;
    connectStartTime = millis();
    Serial.printf("[WiFi] Attempting STA connection to: %s\n", staSSID.c_str());
  }
}

// Start STA connection attempt (non-blocking, AP stays up)
void beginStaConnection() {
  if (staSSID.length() == 0) return;

  // Ensure we're in AP_STA mode
  if (!apPortalActive) {
    WiFi.mode(WIFI_STA);
  }
  WiFi.begin(staSSID.c_str(), staPass.c_str());
  staConnecting = true;
  connectStartTime = millis();
  lastStaRetry = millis();
  Serial.printf("[WiFi] STA connecting to: %s\n", staSSID.c_str());
}

// Non-blocking WiFi management loop - call from main loop()
// Handles: portal requests, STA connection monitoring, auto-reconnect
// Returns true if STA is connected
bool wifiManagerLoop() {
  unsigned long now = millis();
  bool staConnected = (WiFi.status() == WL_CONNECTED);

  // Service AP portal if active
  if (apPortalActive) {
    dnsServer.processNextRequest();
    server.handleClient();

    // Track client connections to AP
    if (provState == PROV_AP_STARTED && WiFi.softAPgetStationNum() > 0) {
      provState = PROV_CLIENT_CONNECTED;
    }

    // New credentials received from portal
    if (provState == PROV_CREDS_RECEIVED) {
      saveCredentials(staSSID, staPass);
      beginStaConnection();
      provState = PROV_CONNECTING;
    }
  }

  // STA just connected - shut down AP
  if (staConnected && apPortalActive) {
    stopProvisioningAP();
    staConnecting = false;
    provState = PROV_SUCCESS;
    Serial.printf("[WiFi] STA connected! IP: %s\n", WiFi.localIP().toString().c_str());
  }

  // STA disconnected while we thought it was connected - restart AP
  if (!staConnected && !apPortalActive && !staConnecting) {
    Serial.println("[WiFi] STA lost, restarting AP portal");
    startProvisioningAP();
    // Begin reconnection attempts
    if (staSSID.length() > 0) {
      WiFi.begin(staSSID.c_str(), staPass.c_str());
      staConnecting = true;
      connectStartTime = now;
      lastStaRetry = now;
    }
  }

  // STA connecting timeout - retry periodically (AP stays up)
  if (staConnecting && !staConnected) {
    if (now - lastStaRetry >= STA_RETRY_INTERVAL) {
      WiFi.disconnect();
      delay(50);
      WiFi.begin(staSSID.c_str(), staPass.c_str());
      lastStaRetry = now;
      Serial.println("[WiFi] STA retry...");
    }
  }

  return staConnected;
}

// Check if AP portal is currently running
bool isAPPortalActive() {
  return apPortalActive;
}

ProvisionState getProvisionState() {
  return provState;
}

// Legacy compatibility: blocking connect (used nowhere now, kept for reference)
bool connectWithStoredCredentials() {
  String ssid, pass;
  if (!loadCredentials(ssid, pass)) return false;

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long start = millis();
  while (millis() - start < 8000) {
    delay(250);
    if (WiFi.status() == WL_CONNECTED) return true;
  }

  WiFi.disconnect();
  return false;
}

#endif // WIFI_PROVISION_H
