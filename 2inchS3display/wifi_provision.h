/*
 * wifi_provision.h - WiFi AP mode, DNS captive portal, HTTP server
 * Tripper Telemetry Dashboard V5
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

// Check if WiFi credentials are already stored
bool hasStoredCredentials() {
  prefs.begin("tripper", true);
  String ssid = prefs.getString("ssid", "");
  prefs.end();
  return ssid.length() > 0;
}

// Load stored credentials
bool loadCredentials(String &ssid, String &pass) {
  prefs.begin("tripper", true);
  ssid = prefs.getString("ssid", "");
  pass = prefs.getString("pass", "");
  prefs.end();
  return ssid.length() > 0;
}

// Save credentials to NVS
void saveCredentials(const String &ssid, const String &pass) {
  prefs.begin("tripper", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
}

// Clear stored credentials
void clearCredentials() {
  prefs.begin("tripper", false);
  prefs.clear();
  prefs.end();
}

// HTTP handlers
void handleRoot() {
  server.send(200, "text/html", PORTAL_HTML);
}

void handleConnect() {
  if (server.hasArg("ssid") && server.hasArg("pass")) {
    staSSID = server.arg("ssid");
    staPass = server.arg("pass");
    // Respond immediately so the browser gets feedback
    server.send(200, "application/json", "{\"success\":true}");
    // Mark that credentials were received - main loop will handle connection
    provState = PROV_CREDS_RECEIVED;
  } else {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing fields\"}");
  }
}

void handleNotFound() {
  server.sendHeader("Location", String("http://") + AP_PORTAL_IP, true);
  server.send(302, "text/plain", "");
}

// Start the AP and web server
void startProvisioningAP() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  delay(100);

  dnsServer.start(53, "*", WiFi.softAPIP());

  server.on("/", handleRoot);
  server.on("/connect", HTTP_POST, handleConnect);
  server.on("/generate_204", handleRoot);
  server.on("/fwlink", handleRoot);
  server.onNotFound(handleNotFound);
  server.begin();

  provState = PROV_AP_STARTED;
}

// Stop AP and all services
void stopProvisioningAP() {
  dnsServer.stop();
  server.stop();
  WiFi.softAPdisconnect(true);
}

// Non-blocking provisioning poll
// Returns the current state - caller handles transitions
ProvisionState provisioningLoop() {
  dnsServer.processNextRequest();
  server.handleClient();

  // Detect client connection to AP
  if (provState == PROV_AP_STARTED && WiFi.softAPgetStationNum() > 0) {
    provState = PROV_CLIENT_CONNECTED;
  }

  return provState;
}

// Start connecting to the user-provided WiFi (non-blocking start)
void startStaConnection() {
  // Switch to AP+STA so we keep serving until connected
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(staSSID.c_str(), staPass.c_str());
  connectStartTime = millis();
  provState = PROV_CONNECTING;
}

// Poll STA connection status (non-blocking)
// Returns: 0 = still trying, 1 = connected, -1 = failed/timeout
int pollStaConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    saveCredentials(staSSID, staPass);
    stopProvisioningAP();
    WiFi.mode(WIFI_STA);
    provState = PROV_SUCCESS;
    return 1;
  }
  if (millis() - connectStartTime > 12000) {
    // Timeout - failed
    WiFi.disconnect();
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    dnsServer.start(53, "*", WiFi.softAPIP());
    provState = PROV_FAILED;
    return -1;
  }
  return 0;  // still trying
}

// Try connecting with stored credentials (blocking, for boot)
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

ProvisionState getProvisionState() {
  return provState;
}

#endif // WIFI_PROVISION_H
