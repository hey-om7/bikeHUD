/*
 * air_quality.h - Air Quality API fetcher (Open-Meteo)
 * Tripper Telemetry Dashboard V5
 *
 * Fetches elevation, UV index, and US AQI from the Open-Meteo Air Quality API
 * every 10 minutes. Uses a dummy GPS function that returns fixed coordinates
 * (to be replaced with real GPS data later).
 *
 * All exposed values are integers:
 *   elevation -> altitude widget
 *   uv_index  -> UV widget
 *   us_aqi    -> AQI widget
 *
 * The fetched values are exposed via getAirQuality() and fed into the dashboard.
 */
#ifndef AIR_QUALITY_H
#define AIR_QUALITY_H

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ===== Fetch Interval =====
#define AQ_FETCH_INTERVAL_MS  (10UL * 60UL * 1000UL)  // 10 minutes

// ===== Air Quality Data (all integers) =====
struct AirQualityData {
  int  elevation;   // meters      -> altitude widget
  int  uvIndex;     // UV index    -> UV widget
  int  usAqi;       // US AQI      -> AQI widget
  bool valid;       // true once first successful fetch completes
};

static AirQualityData aqData = { 0, -1, -1, false };
static unsigned long lastAqFetch = 0;
static bool aqFirstFetchDone = false;

// ===== Dummy GPS Function =====
// Returns fixed coordinates for now. Replace the body with real GPS data later;
// callers only depend on the two out-params.
void getGPSCoordinates(float &latitude, float &longitude) {
  latitude  = 18.56f;
  longitude = 73.941f;
}

// ===== Fetch Air Quality from Open-Meteo API =====
// Returns immediately if WiFi is not connected. Performs a synchronous HTTP GET
// (the API is fast) and parses elevation, uv_index and us_aqi as integers.
bool fetchAirQuality() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[AQ] WiFi not connected, skipping fetch");
    return false;
  }

  float lat, lng;
  getGPSCoordinates(lat, lng);

  // Build request URL from the (dummy) GPS coordinates
  char url[256];
  snprintf(url, sizeof(url),
    "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=%.4f&longitude=%.4f&current=uv_index,us_aqi",
    lat, lng);

  HTTPClient http;
  http.begin(url);
  http.setTimeout(10000);  // 10 second timeout

  int httpCode = http.GET();

  if (httpCode != 200) {
    Serial.printf("[AQ] HTTP GET failed, code: %d\n", httpCode);
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();

  // Parse JSON response
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.printf("[AQ] JSON parse error: %s\n", err.c_str());
    return false;
  }

  // Expected structure:
  //   "elevation": 567,
  //   "current": { "uv_index": 2.9, "us_aqi": 31 }
  // uv_index may arrive as a decimal; we round to the nearest integer.
  if (doc.containsKey("elevation") && doc.containsKey("current")) {
    aqData.elevation = (int) lroundf(doc["elevation"].as<float>());
    aqData.uvIndex   = (int) lroundf(doc["current"]["uv_index"].as<float>());
    aqData.usAqi     = doc["current"]["us_aqi"].as<int>();
    aqData.valid     = true;

    Serial.printf("[AQ] Fetched: elevation=%dm, UV=%d, AQI=%d\n",
      aqData.elevation, aqData.uvIndex, aqData.usAqi);
    return true;
  }

  Serial.println("[AQ] Unexpected JSON structure");
  return false;
}

// ===== Init: prepare module (first fetch happens once WiFi is up) =====
void initAirQuality() {
  lastAqFetch = 0;
  aqFirstFetchDone = false;
  Serial.println("[AQ] Air quality module initialized");
}

// ===== Loop: call from main loop; handles first fetch + 10-minute interval =====
void airQualityLoop() {
  unsigned long now = millis();

  // First fetch: try as soon as WiFi is connected
  if (!aqFirstFetchDone) {
    if (WiFi.status() == WL_CONNECTED) {
      if (fetchAirQuality()) {
        aqFirstFetchDone = true;
        lastAqFetch = now;
      }
    }
    return;
  }

  // Subsequent fetches: every 10 minutes
  if (now - lastAqFetch >= AQ_FETCH_INTERVAL_MS) {
    fetchAirQuality();
    lastAqFetch = now;
  }
}

// ===== Getter for dashboard integration =====
const AirQualityData& getAirQuality() {
  return aqData;
}

#endif // AIR_QUALITY_H
