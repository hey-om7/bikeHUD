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
// Pre-rendered screen coordinates from server (320x240 canvas)
#define MAX_MAIN_PATH_POINTS  96
#define MAX_SIDE_PATHS        10
#define MAX_SIDE_PATH_POINTS  12

struct PathPoint {
  int16_t x;
  int16_t y;
};

struct SidePath {
  PathPoint points[MAX_SIDE_PATH_POINTS];
  uint8_t count;
};

struct NavChunk {
  uint8_t chunkIndex;
  uint8_t totalChunks;
  char instruction[32];     // e.g. "Turn right", "Continue straight"
  char direction[4];        // "R", "L", "S", "U" (right, left, straight, u-turn)
  uint16_t distanceMeters;  // distance to next instruction
  int16_t bearing;          // 0-359 degrees
  // Server-rendered smooth path (screen coordinates)
  PathPoint mainPath[MAX_MAIN_PATH_POINTS];
  uint8_t mainPathCount;
  // Side roads (wrong-turn indicators)
  SidePath sidePaths[MAX_SIDE_PATHS];
  uint8_t sidePathCount;
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

// ===== Double-Buffered Frames for Smooth Interpolation =====
// We keep TWO consecutive frames so the display can lerp between them.
static NavChunk frameA;        // The frame we're interpolating FROM
static NavChunk frameB;        // The frame we're interpolating TO
static bool frameBReady = false;  // frameB has valid data to interpolate toward
static bool frameAValid = false;  // frameA has been populated at least once

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

  // --- NAV_CHUNK: navigation data chunk (server-rendered paths) ---
  else if (strcmp(msgType, "NAV_CHUNK") == 0) {
    currentChunk.chunkIndex = doc["chunkIndex"] | 0;
    currentChunk.totalChunks = doc["totalChunks"] | 1;
    strlcpy(currentChunk.instruction, doc["instruction"] | "Continue", sizeof(currentChunk.instruction));
    strlcpy(currentChunk.direction, doc["direction"] | "S", sizeof(currentChunk.direction));
    currentChunk.distanceMeters = doc["distance"] | 0;
    currentChunk.bearing = doc["bearing"] | 0;
    currentChunk.isLast = doc["isLast"] | false;

    // Parse mainPath: array of [x, y] screen coordinates
    JsonArray mainPath = doc["mainPath"].as<JsonArray>();
    currentChunk.mainPathCount = 0;
    if (mainPath) {
      for (size_t i = 0; i < mainPath.size() && i < MAX_MAIN_PATH_POINTS; i++) {
        JsonArray pt = mainPath[i].as<JsonArray>();
        if (pt && pt.size() >= 2) {
          currentChunk.mainPath[i].x = pt[0].as<int16_t>();
          currentChunk.mainPath[i].y = pt[1].as<int16_t>();
          currentChunk.mainPathCount++;
        }
      }
    }

    // Parse sidePaths: array of arrays of [x, y]
    JsonArray sidePaths = doc["sidePaths"].as<JsonArray>();
    currentChunk.sidePathCount = 0;
    if (sidePaths) {
      for (size_t s = 0; s < sidePaths.size() && s < MAX_SIDE_PATHS; s++) {
        JsonArray sp = sidePaths[s].as<JsonArray>();
        currentChunk.sidePaths[s].count = 0;
        if (sp) {
          for (size_t p = 0; p < sp.size() && p < MAX_SIDE_PATH_POINTS; p++) {
            JsonArray pt = sp[p].as<JsonArray>();
            if (pt && pt.size() >= 2) {
              currentChunk.sidePaths[s].points[p].x = pt[0].as<int16_t>();
              currentChunk.sidePaths[s].points[p].y = pt[1].as<int16_t>();
              currentChunk.sidePaths[s].count++;
            }
          }
        }
        currentChunk.sidePathCount++;
      }
    }

    hasNewChunk = true;

    // Feed the double buffer for smooth interpolation:
    // If frameA isn't valid yet, this is the very first frame — set it directly.
    // If frameA is valid but frameB isn't ready, load into frameB (we now have a pair).
    // If both are valid, promote frameB→frameA and load new data into frameB.
    if (!frameAValid) {
      memcpy(&frameA, &currentChunk, sizeof(NavChunk));
      frameAValid = true;
      frameBReady = false;
    } else if (!frameBReady) {
      memcpy(&frameB, &currentChunk, sizeof(NavChunk));
      frameBReady = true;
    } else {
      memcpy(&frameA, &frameB, sizeof(NavChunk));
      memcpy(&frameB, &currentChunk, sizeof(NavChunk));
      // frameBReady stays true
    }

    Serial.printf("[NAV] Received chunk %d/%d: %s (%d path pts, %d side roads)\n",
      currentChunk.chunkIndex + 1, currentChunk.totalChunks,
      currentChunk.instruction, currentChunk.mainPathCount, currentChunk.sidePathCount);
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

// ===== Interpolation Accessors =====
NavChunk* getFrameA() { return &frameA; }
NavChunk* getFrameB() { return &frameB; }
bool isFrameBReady() { return frameBReady; }
bool isFrameAValid() { return frameAValid; }

// After interpolation completes (t reaches 1.0), promote frameB to frameA
// and request the next frame from the server.
void promoteFrameB() {
  memcpy(&frameA, &frameB, sizeof(NavChunk));
  frameBReady = false;
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
  memset(&frameA, 0, sizeof(frameA));
  memset(&frameB, 0, sizeof(frameB));
  frameAValid = false;
  frameBReady = false;
}

#endif // SERVER_CONNECTION_H
