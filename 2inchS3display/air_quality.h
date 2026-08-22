/*
 * air_quality.h - Air Quality API fetcher (Open-Meteo)
 * Tripper Telemetry Dashboard V5
 *
 * Fetches elevation, UV index, and US AQI from the Open-Meteo Air Quality API
 * every 10 minutes, using the device's REAL GPS coordinates (from the NEO-7M).
 * Until the GPS gets its first fix a fallback location is used so the widgets
 * are not blank; the first real fix triggers an immediate refetch.
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

// Real GPS fix (defined in main .ino, parsed in sensors.h).
extern float gpsLat;
extern float gpsLng;
extern bool  gpsFix;

// Fallback location used only until the first satellite fix arrives.
#define AQ_FALLBACK_LAT  18.56f
#define AQ_FALLBACK_LNG  73.941f

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
static bool aqUsedRealFix = false;   // did the last fetch use a real GPS fix?

// ===== Current GPS Coordinates =====
// Fills lat/lng with the device's real GPS fix. Returns true if the fix is
// valid; false (with fallback coordinates) if the module has no fix yet.
bool getGPSCoordinates(float &latitude, float &longitude) {
  if (gpsFix && (gpsLat != 0.0f || gpsLng != 0.0f)) {
    latitude  = gpsLat;
    longitude = gpsLng;
    return true;
  }
  latitude  = AQ_FALLBACK_LAT;
  longitude = AQ_FALLBACK_LNG;
  return false;
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
  bool realFix = getGPSCoordinates(lat, lng);
  Serial.printf("[AQ] Fetching for %s coords: %.4f, %.4f\n",
                realFix ? "REAL GPS" : "FALLBACK (no fix yet)", lat, lng);

  // Build request URL from the current GPS coordinates
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
    aqUsedRealFix    = realFix;

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

  // Upgrade from fallback to real coordinates: if the first fetch used the
  // fallback location and we've since acquired a real GPS fix, refetch now so
  // the widgets reflect the rider's actual location without waiting 10 minutes.
  if (!aqUsedRealFix && gpsFix && (gpsLat != 0.0f || gpsLng != 0.0f)) {
    Serial.println("[AQ] Real GPS fix acquired - refetching for actual location");
    if (fetchAirQuality()) {
      lastAqFetch = now;
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
