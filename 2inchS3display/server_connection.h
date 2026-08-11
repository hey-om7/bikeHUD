/*
 * server_connection.h - Background WebSocket connection to navigation server
 * Tripper Telemetry Dashboard V5
 *
 * This module runs in the background after WiFi connects.
 * It does NOT interfere with existing WiFi provisioning, homescreen, or retry logic.
 * Navigation only starts when explicitly commanded by the server.
 */
#ifndef SERVER_CONNECTION_H
#define SERVER_CONNECTION_H

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "config.h"

// ===== Server Configuration =====
#define SERVER_HOST       "192.168.1.100"  // Backend server on local network
#define SERVER_PORT       3001
#define SERVER_WS_PATH    "/device"
#define DEVICE_ID         "tripper-001"

// Reconnect interval (ms)
#define SERVER_RECONNECT_INTERVAL  5000

// ===== Server Connection State =====
enum ServerState {
  SRV_DISCONNECTED,
  SRV_CONNECTING,
  SRV_CONNECTED
};

// ===== Navigation State =====
enum NavState {
  NAV_IDLE,
  NAV_ACTIVE,
  NAV_COMPLETE
};

// ===== Navigation Chunk Data =====
struct NavChunk {
  uint8_t chunkIndex;
  uint8_t totalChunks;
  char instruction[32];     // e.g. "Turn right", "Continue straight"
  char direction[4];        // "R", "L", "S", "U" (right, left, straight, u-turn)
  uint16_t distanceMeters;  // distance to next instruction
  int16_t bearing;          // 0-359 degrees
  // Breadcrumb path points (simplified polyline segment)
  int8_t pathOffsets[20];   // relative x,y offsets for breadcrumb rendering (10 points)
  uint8_t pathPointCount;
  bool isLast;
};

// ===== Module State =====
static WebSocketsClient wsClient;
static ServerState serverState = SRV_DISCONNECTED;
static NavState navState = NAV_IDLE;
static NavChunk currentChunk;
static bool hasNewChunk = false;
static unsigned long lastServerAttempt = 0;
static bool serverModuleInitialized = false;

// GPS Mock/Interface (development mode - dummy coordinates)
static float deviceLat = 18.5534;   // Kharadi, Pune
static float deviceLng = 73.9468;
static bool gpsDataValid = false;

// Forward declarations
void handleServerMessage(uint8_t *payload, size_t length);
void sendDeviceIdentify();
void requestNextChunk(uint8_t nextIndex);

// ===== WebSocket Event Handler =====
void wsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      serverState = SRV_DISCONNECTED;
      Serial.println("[WS] Disconnected from server");
      break;

    case WStype_CONNECTED:
      serverState = SRV_CONNECTED;
      Serial.println("[WS] Connected to server");
      sendDeviceIdentify();
      break;

    case WStype_TEXT:
      handleServerMessage(payload, length);
      break;

    case WStype_PING:
      // Handled automatically by library
      break;

    case WStype_PONG:
      break;

    case WStype_ERROR:
      Serial.println("[WS] Error");
      break;

    default:
      break;
  }
}

// ===== Send Device Identification =====
void sendDeviceIdentify() {
  JsonDocument doc;
  doc["type"] = "DEVICE_IDENTIFY";
  doc["deviceId"] = DEVICE_ID;
  doc["lat"] = deviceLat;
  doc["lng"] = deviceLng;
  doc["gpsValid"] = gpsDataValid;

  char buffer[256];
  serializeJson(doc, buffer);
  wsClient.sendTXT(buffer);
}

// ===== Handle Incoming Server Messages =====
void handleServerMessage(uint8_t *payload, size_t length) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print("[WS] JSON parse error: ");
    Serial.println(err.c_str());
    return;
  }

  const char *msgType = doc["type"];
  if (!msgType) return;

  // --- START_NAVIGATION command ---
  if (strcmp(msgType, "START_NAVIGATION") == 0) {
    navState = NAV_ACTIVE;
    hasNewChunk = false;
    Serial.println("[NAV] Navigation started by server command");
    // Request the first chunk
    requestNextChunk(0);
  }

  // --- NAV_CHUNK: navigation data chunk ---
  else if (strcmp(msgType, "NAV_CHUNK") == 0) {
    currentChunk.chunkIndex = doc["chunkIndex"] | 0;
    currentChunk.totalChunks = doc["totalChunks"] | 1;
    strlcpy(currentChunk.instruction, doc["instruction"] | "Continue", sizeof(currentChunk.instruction));
    strlcpy(currentChunk.direction, doc["direction"] | "S", sizeof(currentChunk.direction));
    currentChunk.distanceMeters = doc["distance"] | 0;
    currentChunk.bearing = doc["bearing"] | 0;
    currentChunk.isLast = doc["isLast"] | false;

    // Parse path offsets
    JsonArray path = doc["path"].as<JsonArray>();
    currentChunk.pathPointCount = 0;
    if (path) {
      for (size_t i = 0; i < path.size() && i < 20; i++) {
        currentChunk.pathOffsets[i] = path[i].as<int8_t>();
        currentChunk.pathPointCount++;
      }
    }
    currentChunk.pathPointCount /= 2; // pairs of x,y

    hasNewChunk = true;
    Serial.printf("[NAV] Received chunk %d/%d: %s\n",
      currentChunk.chunkIndex + 1, currentChunk.totalChunks, currentChunk.instruction);
  }

  // --- STOP_NAVIGATION command ---
  else if (strcmp(msgType, "STOP_NAVIGATION") == 0) {
    navState = NAV_IDLE;
    hasNewChunk = false;
    memset(&currentChunk, 0, sizeof(currentChunk));
    Serial.println("[NAV] Navigation stopped by server");
  }

  // --- NAV_COMPLETE: navigation finished ---
  else if (strcmp(msgType, "NAV_COMPLETE") == 0) {
    navState = NAV_COMPLETE;
    Serial.println("[NAV] Destination reached!");
  }

  // --- GPS_REQUEST: server asking for current location ---
  else if (strcmp(msgType, "GPS_REQUEST") == 0) {
    JsonDocument resp;
    resp["type"] = "GPS_UPDATE";
    resp["deviceId"] = DEVICE_ID;
    resp["lat"] = deviceLat;
    resp["lng"] = deviceLng;
    resp["valid"] = gpsDataValid;
    char buf[200];
    serializeJson(resp, buf);
    wsClient.sendTXT(buf);
  }
}

// ===== Request Next Navigation Chunk =====
void requestNextChunk(uint8_t nextIndex) {
  if (serverState != SRV_CONNECTED) return;

  JsonDocument doc;
  doc["type"] = "REQUEST_CHUNK";
  doc["deviceId"] = DEVICE_ID;
  doc["chunkIndex"] = nextIndex;

  char buffer[128];
  serializeJson(doc, buffer);
  wsClient.sendTXT(buffer);
}

// ===== Initialize Server Connection Module =====
// Call ONCE after WiFi first connects in the dashboard state
void initServerConnection() {
  if (serverModuleInitialized) return;

  wsClient.begin(SERVER_HOST, SERVER_PORT, SERVER_WS_PATH);
  wsClient.onEvent(wsEvent);
  wsClient.setReconnectInterval(SERVER_RECONNECT_INTERVAL);
  wsClient.enableHeartbeat(15000, 3000, 2);

  serverModuleInitialized = true;
  serverState = SRV_CONNECTING;
  Serial.println("[WS] Server connection module initialized");
}

// ===== Server Connection Loop =====
// Call from main loop() in DASHBOARD state - non-blocking
void serverConnectionLoop() {
  if (!serverModuleInitialized) return;
  wsClient.loop();
}

// ===== Update GPS coordinates (called from GPS parser or mock) =====
void updateDeviceGPS(float lat, float lng, bool valid) {
  deviceLat = lat;
  deviceLng = lng;
  gpsDataValid = valid;
}

// ===== Public Getters =====
ServerState getServerState() { return serverState; }
NavState getNavState() { return navState; }
bool hasNavigationChunk() { return hasNewChunk; }

NavChunk* getCurrentNavChunk() {
  hasNewChunk = false;  // Mark as consumed
  return &currentChunk;
}

// Advance to next chunk after current is rendered
void advanceNavigation() {
  if (navState != NAV_ACTIVE) return;
  if (currentChunk.isLast) {
    // Navigation complete
    navState = NAV_COMPLETE;
    // Notify server
    JsonDocument doc;
    doc["type"] = "NAV_CHUNK_CONSUMED";
    doc["deviceId"] = DEVICE_ID;
    doc["chunkIndex"] = currentChunk.chunkIndex;
    doc["complete"] = true;
    char buf[128];
    serializeJson(doc, buf);
    wsClient.sendTXT(buf);
  } else {
    requestNextChunk(currentChunk.chunkIndex + 1);
  }
}

// Clear navigation state (after NAV_COMPLETE acknowledged)
void clearNavigation() {
  navState = NAV_IDLE;
  hasNewChunk = false;
  memset(&currentChunk, 0, sizeof(currentChunk));
}

#endif // SERVER_CONNECTION_H
